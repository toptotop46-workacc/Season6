import { privateKeyToAccount } from 'viem/accounts'
import { formatEther } from 'viem'
import { rpcManager, soneiumChain } from './rpc-manager.js'
import { ProxyManager } from './proxy-manager.js'
import { ETHBalanceChecker } from './eth-balance-checker.js'
import { MEXCWithdraw } from './mexc-withdraw.js'
import { GasChecker } from './gas-checker.js'
import { logger } from './logger.js'
import { fileLogger } from './file-logger.js'

// LI.FI конфигурация (как в jumper.ts)
const LI_FI_CONFIG = {
  INTEGRATOR: 'Soneium',
  FEE_PERCENTAGE: '0.005'
}

// Конфигурация для расчета газа
const GAS_CONFIG = {
  GAS_LIMIT_MULTIPLIER: 1.5, // Множитель для gas limit (1.5x от оценки)
  GAS_BUFFER_PERCENTAGE: 10, // Буфер для газа в процентах (10%)
  PRIORITY_FEE_GWEI: 0.1, // Priority fee в gwei для EIP-1559
  BASE_FEE_MULTIPLIER: 2, // Множитель для base fee (2x)
  FALLBACK_GAS_PRICE_GWEI: 20, // Fallback gas price в gwei для legacy сетей
  FALLBACK_RESERVE_PERCENTAGE: 3, // Fallback резерв в процентах (3%)
  MEXC_WITHDRAW_DELAY_MS: 30000, // Задержка после вывода с MEXC в миллисекундах (30 сек)
  // Итеративный поиск оптимальной суммы
  ITERATIVE_STEP_SIZE: 0.01, // Шаг уменьшения (1%)
  MIN_AMOUNT_PERCENTAGE: 0.90, // Минимум 90% от исходной суммы
  MAX_ITERATIONS: 10, // Максимум 10 итераций (100% - 90% = 10%)
  GAS_ESTIMATION_TIMEOUT: 5000, // Таймаут оценки газа (5 сек)
  // Retry механизм
  RETRY_ATTEMPTS: 5, // Максимум 5 попыток
  RETRY_DELAY_MS: 2000, // Задержка между попытками (2 сек)
  RETRY_BACKOFF_MULTIPLIER: 1.5, // Увеличение задержки (1.5x)
  MAX_RETRY_DELAY_MS: 10000 // Максимальная задержка (10 сек)
}

/**
 * Интерфейс для результата пополнения
 */
interface TopupResult {
  success: boolean
  walletAddress: string
  strategy: 'search' | 'withdraw' | 'sufficient'
  sourceNetwork?: string
  amountUSD: number
  amountETH: string
  mexcWithdrawId?: string | undefined
  bridgeTxHash?: string | undefined
  totalGasUsed?: string
  error?: string | undefined
}

/**
 * Интерфейс для конфигурации пополнения
 */
interface TopupConfig {
  minAmountUSD: number
  maxAmountUSD: number
  minDelayMinutes: number
  maxDelayMinutes: number
}

/**
 * Интерфейс для ответа LI.FI API (соответствует jumper.ts)
 */
interface LIFIQuoteResponse {
  transactionRequest: {
    to: string
    value: string
    data: string
    gasLimit: string
    gasPrice?: string
    chainId?: number
  }
  estimate?: {
    toAmount?: string
    fromAmount?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Класс для пополнения кошельков ETH в сети Soneium
 */
export class WalletTopup {
  private privateKey: `0x${string}`
  private account: ReturnType<typeof privateKeyToAccount>
  private proxyManager: ProxyManager

  constructor (privateKey: `0x${string}`) {
    this.privateKey = privateKey
    this.account = privateKeyToAccount(privateKey)
    this.proxyManager = ProxyManager.getInstance()
  }

  /**
   * Получает адрес кошелька
   */
  getWalletAddress (): string {
    return this.account.address
  }

  /**
   * Получает цену ETH через API
   */
  private async fetchETHPrice (): Promise<number> {
    try {
      console.log('📈 Получаем цену ETH...')
      const response = await fetch('https://api.relay.link/currencies/token/price?address=0x0000000000000000000000000000000000000000&chainId=1')

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      const price = data.price

      if (typeof price !== 'number' || price <= 0) {
        throw new Error('Неверный формат цены ETH')
      }

      console.log(`💰 Текущая цена ETH: $${price.toFixed(2)}`)
      return price
    } catch (error) {
      console.error('❌ Ошибка получения цены ETH:', error)
      throw new Error('Не удалось получить цену ETH')
    }
  }

  /**
   * Конвертирует USD в ETH
   */
  private convertUSDToETH (usdAmount: number, ethPrice: number): number {
    return usdAmount / ethPrice
  }

  /**
   * Генерирует случайную сумму в USD
   */
  private generateRandomAmount (minUSD: number, maxUSD: number): number {
    return Math.random() * (maxUSD - minUSD) + minUSD
  }

  /**
   * Проверяет баланс ETH в сети Soneium
   */
  private async getSoneiumETHBalance (): Promise<number> {
    try {
      const client = rpcManager.createPublicClient(soneiumChain)
      const balance = await client.getBalance({ address: this.account.address })
      return parseFloat(formatEther(balance))
    } catch (error) {
      console.error('❌ Ошибка получения баланса Soneium:', error)
      return 0
    }
  }

  /**
   * Проверяет балансы ETH в других сетях
   */
  private async checkOtherNetworksBalances (): Promise<{ network: string; balance: number }[]> {
    try {
      const balanceChecker = new ETHBalanceChecker(this.account.address, 500) // 500ms задержка между запросами
      const results = await balanceChecker.checkAllNetworks()

      return results.map(result => ({
        network: result.network,
        balance: result.balance
      }))
    } catch (error) {
      console.error('❌ Ошибка проверки балансов:', error)
      return []
    }
  }

  /**
   * Выбирает лучшую стратегию пополнения
   */
  private selectTopupStrategy (balances: { network: string; balance: number }[], requiredAmount: number): 'search' | 'withdraw' {
    // Если есть достаточный баланс в других сетях, используем стратегию поиска
    const hasEnoughBalance = balances.some(b => b.balance >= requiredAmount)
    return hasEnoughBalance ? 'search' : 'withdraw'
  }

  /**
   * Получает баланс в конкретной сети (оптимизированная версия)
   */
  private async getNetworkBalance (network: string): Promise<number> {
    try {
      // Получаем конфигурацию сети напрямую
      const networkConfigs = [
        { name: 'ARB', chainId: 42161, rpc: ['https://arbitrum-one.publicnode.com'], explorer: 'https://arbiscan.io' },
        { name: 'OP', chainId: 10, rpc: ['https://optimism.publicnode.com'], explorer: 'https://optimistic.etherscan.io' },
        { name: 'BASE', chainId: 8453, rpc: ['https://base.publicnode.com'], explorer: 'https://basescan.org' }
      ]

      // Нормализуем название сети (приводим к верхнему регистру)
      const normalizedNetwork = network.toUpperCase()

      // Маппинг названий сетей от MEXC к внутренним названиям
      const networkMapping: Record<string, string> = {
        'ARBITRUM ONE(ARB)': 'ARB',
        'OPTIMISM(OP)': 'OP',
        'BASE': 'BASE'
      }

      const mappedNetwork = networkMapping[normalizedNetwork] || normalizedNetwork
      console.log(`🔍 Ищем конфигурацию для сети: "${network}" -> "${normalizedNetwork}" -> "${mappedNetwork}"`)

      const targetConfig = networkConfigs.find(config => config.name === mappedNetwork)
      if (!targetConfig) {
        console.error(`❌ Неизвестная сеть: ${network} (нормализовано: ${normalizedNetwork}, маппинг: ${mappedNetwork})`)
        console.error(`📋 Доступные сети: ${networkConfigs.map(c => c.name).join(', ')}`)
        console.error(`📋 Маппинг: ${Object.entries(networkMapping).map(([k, v]) => `${k}->${v}`).join(', ')}`)
        return 0
      }

      // Проверяем баланс только в нужной сети
      const balance = await this.checkSingleNetworkBalance(targetConfig)

      console.log(`🔍 Проверка баланса ${network}: ${balance.toFixed(6)} ETH`)

      return balance
    } catch (error) {
      console.error(`❌ Ошибка получения баланса ${network}:`, error)
      return 0
    }
  }

  /**
   * Проверяет баланс в одной конкретной сети
   */
  private async checkSingleNetworkBalance (networkConfig: { name: string; chainId: number; rpc: string[]; explorer: string }): Promise<number> {
    const { createPublicClient, http, formatEther } = await import('viem')

    for (const rpcUrl of networkConfig.rpc) {
      try {
        const client = createPublicClient({
          chain: {
            id: networkConfig.chainId,
            name: networkConfig.name,
            network: networkConfig.name.toLowerCase(),
            nativeCurrency: {
              decimals: 18,
              name: 'Ether',
              symbol: 'ETH'
            },
            rpcUrls: {
              default: { http: [rpcUrl] },
              public: { http: [rpcUrl] }
            },
            blockExplorers: {
              default: { name: 'Explorer', url: networkConfig.explorer }
            }
          },
          transport: http(rpcUrl)
        })

        const balance = await client.getBalance({ address: this.account.address as `0x${string}` })
        return parseFloat(formatEther(balance))
      } catch (error) {
        console.log(`⚠️ RPC ${rpcUrl} не работает для ${networkConfig.name}: ${error}`)
        continue
      }
    }

    throw new Error(`Все RPC недоступны для ${networkConfig.name}`)
  }

  /**
   * Ожидает поступления средств на баланс
   */
  private async waitForBalanceUpdate (network: string, expectedAmount: number, maxWaitTime: number = 300000): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 10000 // 10 секунд
    let attemptCount = 0
    const ETH_EPSILON = 0.000001 // 1 микроЭTH для толерантности сравнения

    console.log(`⏳ Ожидаем поступления ${expectedAmount.toFixed(6)} ETH на ${network}...`)

    while (Date.now() - startTime < maxWaitTime) {
      attemptCount++
      const elapsedTime = Math.round((Date.now() - startTime) / 1000)
      try {
        const currentBalance = await this.getNetworkBalance(network)

        console.log(`⏳ Попытка ${attemptCount}, время: ${elapsedTime}с, Баланс ${network}: ${currentBalance.toFixed(6)} ETH, ожидаем: ${expectedAmount.toFixed(6)} ETH`)

        // Используем толерантность для сравнения чисел с плавающей точкой
        if (currentBalance >= expectedAmount - ETH_EPSILON) {
          console.log(`✅ Средства поступили! Баланс ${network}: ${currentBalance.toFixed(6)} ETH (ожидалось: ${expectedAmount.toFixed(6)} ETH)`)
          return true
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval))

      } catch {
        // Убираем техническую информацию - ошибки проверки баланса
        await new Promise(resolve => setTimeout(resolve, checkInterval))
      }
    }

    console.log(`❌ Время ожидания истекло (${Math.round(maxWaitTime / 1000)}с), средства не поступили на ${network}`)
    return false
  }

  /**
   * Выбирает подходящую сеть для вывода с учетом минимальной суммы
   */
  private async selectSuitableNetworkForWithdraw (amountETH: number, availableNetworks: string[]): Promise<string> {
    try {
      // Получаем конфигурацию MEXC
      const mexcConfig = await this.loadMEXCConfig()
      const mexcClient = new MEXCWithdraw(mexcConfig)

      // Получаем доступные сети с их минимальными суммами
      const networks = await mexcClient.getWithdrawNetworks()

      // Фильтруем сети, где наша сумма больше минимальной
      const suitableNetworks = networks.filter(network =>
        amountETH >= network.withdrawMin
      )

      if (suitableNetworks.length === 0) {
        const minAmounts = networks.map(n => `${n.network}: ${n.withdrawMin} ETH`).join(', ')
        throw new Error(`Сумма ${amountETH} ETH меньше минимальной для всех доступных сетей. Минимальные суммы: ${minAmounts}`)
      }

      // Выбираем случайную из подходящих сетей
      const randomIndex = Math.floor(Math.random() * suitableNetworks.length)
      const selectedNetwork = suitableNetworks[randomIndex]!

      console.log(`📊 Подходящие сети: ${suitableNetworks.map(n => `${n.network}(${n.withdrawMin})`).join(', ')}`)
      console.log(`✅ Выбрана сеть: ${selectedNetwork.network} (мин: ${selectedNetwork.withdrawMin} ETH)`)

      return selectedNetwork.network
    } catch (error) {
      console.error('❌ Ошибка при выборе подходящей сети:', error)
      // Fallback к случайному выбору
      const randomIndex = Math.floor(Math.random() * availableNetworks.length)
      return availableNetworks[randomIndex]!
    }
  }

  /**
   * Оценивает стоимость газа для конкретной суммы
   */
  private async estimateGasForAmount (sourceNetwork: string, amount: number): Promise<number> {
    try {
      // Получаем котировку для конкретной суммы
      const quote = await this.getBridgeQuote(sourceNetwork, amount)
      if (!quote) {
        throw new Error('Не удалось получить котировку для оценки газа')
      }

      // Создаем клиент для оценки
      const { publicClient } = await this.createSourceNetworkClient(sourceNetwork)

      // Оцениваем газ с таймаутом
      const estimatedGas = await Promise.race([
        publicClient.estimateGas({
          to: quote.transactionRequest.to as `0x${string}`,
          data: quote.transactionRequest.data as `0x${string}`,
          value: BigInt(quote.transactionRequest.value),
          account: this.account
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Таймаут оценки газа')), GAS_CONFIG.GAS_ESTIMATION_TIMEOUT)
        )
      ])

      // Рассчитываем стоимость газа
      const gasLimit = BigInt(Math.floor(Number(estimatedGas) * GAS_CONFIG.GAS_LIMIT_MULTIPLIER))
      const block = await publicClient.getBlock()
      const baseFee = block.baseFeePerGas || 0n

      let feePerGas: bigint
      if (baseFee > 0n) {
        // EIP-1559
        const maxPriorityFeePerGas = BigInt(GAS_CONFIG.PRIORITY_FEE_GWEI * 1e9)
        feePerGas = baseFee * BigInt(GAS_CONFIG.BASE_FEE_MULTIPLIER) + maxPriorityFeePerGas
      } else {
        // Legacy
        const fallbackGasPriceWei = BigInt(GAS_CONFIG.FALLBACK_GAS_PRICE_GWEI * 1e9)
        feePerGas = BigInt(quote.transactionRequest.gasPrice || fallbackGasPriceWei.toString())
      }

      const gasCost = gasLimit * feePerGas
      return parseFloat(formatEther(gasCost))
    } catch (error) {
      // Извлекаем только основную информацию об ошибке
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств для газа'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else if (error.message.includes('execution reverted')) {
          errorMessage = 'Транзакция отменена'
        } else {
          // Берем только первую строку сообщения
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      console.error(`❌ Ошибка оценки газа для суммы ${amount}: ${errorMessage}`)
      throw error
    }
  }

  /**
   * Динамически рассчитывает оптимальную сумму для бриджа с учетом газа (итеративный подход)
   */
  private async calculateOptimalBridgeAmount (sourceNetwork: string, maxAmount: number): Promise<number> {
    try {
      console.log(`🧮 Рассчитываем оптимальную сумму для бриджа из ${sourceNetwork}...`)

      // Получаем баланс в исходной сети
      const { publicClient } = await this.createSourceNetworkClient(sourceNetwork)
      const balance = await publicClient.getBalance({ address: this.account.address })
      const balanceETH = parseFloat(formatEther(balance))

      console.log(`💰 Доступный баланс в ${sourceNetwork}: ${balanceETH.toFixed(6)} ETH`)

      // Итеративный поиск оптимальной суммы
      let currentAmount = maxAmount
      const minAmount = maxAmount * GAS_CONFIG.MIN_AMOUNT_PERCENTAGE // 90% от исходной суммы
      const stepSize = GAS_CONFIG.ITERATIVE_STEP_SIZE // 1% шаг

      console.log(`🔄 Итеративный поиск: от ${maxAmount.toFixed(6)} ETH до ${minAmount.toFixed(6)} ETH (шаг ${(stepSize * 100).toFixed(0)}%, максимум ${GAS_CONFIG.MAX_ITERATIONS} попыток)`)

      for (let iteration = 1; iteration <= GAS_CONFIG.MAX_ITERATIONS; iteration++) {
        try {
          console.log(`🔄 Итерация ${iteration}: ${currentAmount.toFixed(6)} ETH (${((currentAmount / maxAmount) * 100).toFixed(1)}%)`)

          // Оцениваем стоимость газа для текущей суммы
          const gasEstimate = await this.estimateGasForAmount(sourceNetwork, currentAmount)
          const totalCost = currentAmount + gasEstimate

          console.log(`⛽ Оценка газа: ${gasEstimate.toFixed(6)} ETH, общая стоимость: ${totalCost.toFixed(6)} ETH`)

          if (totalCost <= balanceETH) {
            // Газ помещается - возвращаем эту сумму
            console.log(`✅ Найдена рабочая сумма: ${currentAmount.toFixed(6)} ETH`)
            console.log(`📊 Резерв на газ: ${gasEstimate.toFixed(6)} ETH (${((gasEstimate / balanceETH) * 100).toFixed(1)}%)`)
            return currentAmount
          }

          console.log(`❌ Газ не помещается (${totalCost.toFixed(6)} > ${balanceETH.toFixed(6)}), уменьшаем сумму`)

          // Газ не помещается - уменьшаем сумму
          currentAmount *= (1 - stepSize)

        } catch (error) {
          // Упрощаем сообщение об ошибке
          let errorMessage = 'Неизвестная ошибка'
          if (error instanceof Error) {
            if (error.message.includes('insufficient funds')) {
              errorMessage = 'Недостаточно средств'
            } else if (error.message.includes('gas required exceeds allowance')) {
              errorMessage = 'Газ превышает лимит'
            } else {
              errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
            }
          }
          console.log(`❌ Ошибка оценки газа для ${currentAmount.toFixed(6)} ETH: ${errorMessage}`)
          currentAmount *= (1 - stepSize)
        }
      }

      // Если даже 95% не подошло - пробуем абсолютный минимум
      const absoluteMin = 0.0001 // 0.0001 ETH минимум
      if (absoluteMin < balanceETH) {
        console.log(`🔄 Пробуем абсолютный минимум: ${absoluteMin.toFixed(6)} ETH`)
        try {
          const gasEstimate = await this.estimateGasForAmount(sourceNetwork, absoluteMin)
          if (absoluteMin + gasEstimate <= balanceETH) {
            console.log(`✅ Абсолютный минимум работает: ${absoluteMin.toFixed(6)} ETH`)
            return absoluteMin
          }
        } catch (error) {
          // Упрощаем сообщение об ошибке
          let errorMessage = 'Неизвестная ошибка'
          if (error instanceof Error) {
            if (error.message.includes('insufficient funds')) {
              errorMessage = 'Недостаточно средств'
            } else if (error.message.includes('gas required exceeds allowance')) {
              errorMessage = 'Газ превышает лимит'
            } else {
              errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
            }
          }
          console.log(`❌ Абсолютный минимум не работает: ${errorMessage}`)
        }
      }

      // Если ничего не подошло - выбрасываем ошибку
      throw new Error(`Не удалось найти подходящую сумму для бриджа после ${GAS_CONFIG.MAX_ITERATIONS} попыток. Баланс: ${balanceETH.toFixed(6)} ETH, требуется минимум: ${minAmount.toFixed(6)} ETH`)

    } catch (error) {
      // Упрощаем сообщение об ошибке
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      console.error('❌ Критическая ошибка расчета оптимальной суммы:', errorMessage)
      throw error
    }
  }

  /**
   * Выполняет бридж ETH через Jumper с retry механизмом
   */
  private async performBridgeWithRetry (sourceNetwork: string, amountETH: number, gasChecker?: GasChecker): Promise<{ success: boolean; txHash?: string; error?: string }> {
    let lastError: Error | null = null
    let delay = GAS_CONFIG.RETRY_DELAY_MS

    for (let attempt = 1; attempt <= GAS_CONFIG.RETRY_ATTEMPTS; attempt++) {
      try {
        console.log(`🌉 Попытка бриджа ${attempt}/${GAS_CONFIG.RETRY_ATTEMPTS}: ${amountETH} ETH из ${sourceNetwork} в Soneium...`)

        const result = await this.performBridge(sourceNetwork, amountETH, gasChecker)

        if (result.success) {
          console.log(`✅ Бридж успешен с попытки ${attempt}! TX: ${result.txHash}`)
          return result
        }

        // Если бридж не удался, но без ошибки - не retry
        if (!result.error) {
          return result
        }

        lastError = new Error(result.error)

      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Неизвестная ошибка')
        // Упрощаем сообщение об ошибке
        let errorMessage = lastError.message
        if (errorMessage.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (errorMessage.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = errorMessage.split('\n')[0] ?? 'Неизвестная ошибка'
        }
        console.error(`❌ Попытка ${attempt} не удалась: ${errorMessage}`)
      }

      // Если это не последняя попытка - ждем перед следующей
      if (attempt < GAS_CONFIG.RETRY_ATTEMPTS) {
        console.log(`⏳ Ожидаем ${Math.round(delay / 1000)}с перед попыткой ${attempt + 1}...`)
        await new Promise(resolve => setTimeout(resolve, delay))

        // Увеличиваем задержку для следующей попытки
        delay = Math.min(delay * GAS_CONFIG.RETRY_BACKOFF_MULTIPLIER, GAS_CONFIG.MAX_RETRY_DELAY_MS)
      }
    }

    // Все попытки исчерпаны
    console.error(`❌ Все ${GAS_CONFIG.RETRY_ATTEMPTS} попыток бриджа не удались`)
    return {
      success: false,
      error: `Бридж не удался после ${GAS_CONFIG.RETRY_ATTEMPTS} попыток. Последняя ошибка: ${lastError?.message}`
    }
  }

  /**
   * Выполняет бридж ETH через Jumper
   */
  private async performBridge (sourceNetwork: string, amountETH: number, gasChecker?: GasChecker): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      console.log(`🌉 Выполняем бридж ${amountETH} ETH из ${sourceNetwork} в Soneium...`)

      // 🆕 Проверка цены газа перед бриджем
      await this.checkGasPrice(gasChecker)

      // Получаем котировку от LI.FI для бриджа
      const quote = await this.getBridgeQuote(sourceNetwork, amountETH)
      if (!quote) {
        throw new Error('Не удалось получить котировку для бриджа')
      }

      // Выполняем транзакцию бриджа
      const txHash = await this.executeBridgeTransaction(quote, sourceNetwork)
      console.log(`✅ Бридж выполнен успешно! TX: ${txHash}`)

      return { success: true, txHash }
    } catch (error) {
      // Упрощаем сообщение об ошибке
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      console.error('❌ Ошибка бриджа:', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Получает котировку для бриджа от LI.FI
   */
  private async getBridgeQuote (sourceNetwork: string, amountETH: number): Promise<LIFIQuoteResponse | null> {
    try {
      const sourceChainId = this.getChainIdByName(sourceNetwork)
      const targetChainId = 1868 // Soneium chain ID

      console.log(`🔍 Запрашиваем котировку LI.FI: ${sourceNetwork} (${sourceChainId}) -> Soneium (${targetChainId})`)
      console.log(`💰 Сумма: ${amountETH} ETH`)

      // Используем GET запрос с правильными параметрами
      // Конвертируем ETH в wei с точностью
      const amountWei = Math.round(amountETH * 1e18).toString()
      console.log(`🔢 Конвертация: ${amountETH} ETH -> ${amountWei} wei`)

      const params = new URLSearchParams({
        fromChain: sourceChainId.toString(),
        toChain: targetChainId.toString(),
        fromToken: '0x0000000000000000000000000000000000000000', // ETH
        toToken: '0x0000000000000000000000000000000000000000', // ETH
        fromAmount: amountWei,
        fromAddress: this.account.address,
        toAddress: this.account.address,
        slippage: '0.05',
        order: 'RECOMMENDED',
        integrator: LI_FI_CONFIG.INTEGRATOR,
        fee: LI_FI_CONFIG.FEE_PERCENTAGE
      })

      const response = await fetch(`https://li.quest/v1/quote?${params}`, {
        method: 'GET',
        headers: {
          'x-lifi-api-key': 'aeaa4f26-c3c3-4b71-aad3-50bd82faf815.1e83cb78-2d75-412d-a310-57272fd0e622'
        }
      })

      // Убираем техническую информацию - API ответ

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`❌ LI.FI API ошибка ${response.status}: ${errorText}`)
        throw new Error(`LI.FI API error: ${response.status} - ${errorText}`)
      }

      const quote = await response.json()
      console.log('✅ Котировка LI.FI получена успешно')
      return quote
    } catch (error) {
      console.error('❌ Ошибка получения котировки LI.FI:', error)
      return null
    }
  }

  /**
   * Создает клиент для исходной сети
   */
  public async createSourceNetworkClient (sourceNetwork: string): Promise<{
    walletClient: ReturnType<typeof import('viem').createWalletClient>
    publicClient: ReturnType<typeof import('viem').createPublicClient>
  }> {
    const sourceChainId = this.getChainIdByName(sourceNetwork)

    // Маппинг полных названий сетей на внутренние названия
    const networkMapping: Record<string, string> = {
      'ARBITRUM ONE(ARB)': 'ARB',
      'OPTIMISM(OP)': 'OP',
      'BASE': 'BASE'
    }

    const internalNetwork = networkMapping[sourceNetwork.toUpperCase()] || sourceNetwork.toUpperCase()
    console.log(`🔗 Маппинг сети для клиента: "${sourceNetwork}" -> "${internalNetwork}"`)

    // Конфигурация сетей
    const networkConfigs = {
      'ARB': { name: 'Arbitrum', rpc: 'https://arbitrum-one.publicnode.com', explorer: 'https://arbiscan.io' },
      'OP': { name: 'Optimism', rpc: 'https://optimism.publicnode.com', explorer: 'https://optimistic.etherscan.io' },
      'BASE': { name: 'Base', rpc: 'https://base.publicnode.com', explorer: 'https://basescan.org' }
    }

    const config = networkConfigs[internalNetwork as keyof typeof networkConfigs]
    if (!config) {
      throw new Error(`Неизвестная сеть: ${sourceNetwork} (маппинг: ${internalNetwork})`)
    }

    // ✅ Создаем клиент напрямую с viem с правильными типами
    const { createPublicClient, createWalletClient, http } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')

    const chain = {
      id: sourceChainId,
      name: config.name,
      network: config.name.toLowerCase(),
      nativeCurrency: {
        decimals: 18,
        name: 'Ether',
        symbol: 'ETH'
      },
      rpcUrls: {
        default: { http: [config.rpc] },
        public: { http: [config.rpc] }
      },
      blockExplorers: {
        default: { name: 'Explorer', url: config.explorer }
      }
    }

    const account = privateKeyToAccount(this.privateKey)

    const publicClient = createPublicClient({
      chain,
      transport: http(config.rpc, {
        timeout: 10000,
        retryCount: 3,
        retryDelay: 1000
      })
    })

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.rpc, {
        timeout: 10000,
        retryCount: 3,
        retryDelay: 1000
      })
    })

    return {
      walletClient,
      publicClient
    }
  }

  /**
   * Выполняет транзакцию бриджа
   */
  private async executeBridgeTransaction (quote: LIFIQuoteResponse, sourceNetwork: string): Promise<string> {
    try {
      // ✅ Создаем клиент для исходной сети, а не для Soneium
      const { walletClient, publicClient } = await this.createSourceNetworkClient(sourceNetwork)
      const sourceChainId = this.getChainIdByName(sourceNetwork)

      console.log(`🌐 Выполняем транзакцию в сети: ${sourceNetwork}`)

      // ✅ Получаем баланс и параметры транзакции
      const balance = await publicClient.getBalance({ address: this.account.address })
      const requiredValue = BigInt(quote.transactionRequest.value)

      console.log(`💰 Баланс ${sourceNetwork}: ${formatEther(balance)} ETH`)
      console.log(`💸 Требуется для транзакции: ${formatEther(requiredValue)} ETH`)
      console.log(`🔗 Выполняем транзакцию в ${sourceNetwork} (Chain ID: ${publicClient.chain?.id || 'unknown'})`)

      // ✅ Оцениваем газ динамически с запасом
      const estimatedGas = await publicClient.estimateGas({
        to: quote.transactionRequest.to as `0x${string}`,
        data: quote.transactionRequest.data as `0x${string}`,
        value: BigInt(quote.transactionRequest.value),
        account: this.account
      })

      const gasLimit = BigInt(Math.floor(Number(estimatedGas) * GAS_CONFIG.GAS_LIMIT_MULTIPLIER))

      // ✅ Используем EIP-1559 gas pricing для Arbitrum и других EIP-1559 сетей
      const block = await publicClient.getBlock()
      const baseFee = block.baseFeePerGas || 0n

      let gasParams: Record<string, bigint> = {}

      if (baseFee > 0n) {
        // EIP-1559 сети (Arbitrum, Optimism, Base)
        const maxPriorityFeePerGas = BigInt(GAS_CONFIG.PRIORITY_FEE_GWEI * 1e9) // Конвертируем gwei в wei
        const maxFeePerGas = baseFee * BigInt(GAS_CONFIG.BASE_FEE_MULTIPLIER) + maxPriorityFeePerGas
        gasParams = {
          maxFeePerGas: maxFeePerGas,
          maxPriorityFeePerGas: maxPriorityFeePerGas
        }
      } else {
        // Legacy сети
        const fallbackGasPriceWei = BigInt(GAS_CONFIG.FALLBACK_GAS_PRICE_GWEI * 1e9) // Конвертируем gwei в wei
        const gasPrice = BigInt(quote.transactionRequest.gasPrice || fallbackGasPriceWei.toString())
        gasParams = { gasPrice: gasPrice }
      }

      // ✅ Проверяем достаточность средств с учетом реального газа
      const feePerGas = 'maxFeePerGas' in gasParams ? gasParams['maxFeePerGas']! : gasParams['gasPrice']!
      const gasCost = gasLimit * feePerGas
      const totalRequired = requiredValue + gasCost

      console.log(`⛽ Оценка газа: ${estimatedGas.toString()}, с запасом: ${gasLimit.toString()}`)
      console.log(`💰 Стоимость газа: ${formatEther(gasCost)} ETH`)
      console.log(`💸 Общая стоимость: ${formatEther(totalRequired)} ETH`)

      if (balance < totalRequired) {
        throw new Error(`Недостаточно средств: ${formatEther(balance)} < ${formatEther(totalRequired)} (включая газ)`)
      }

      // ✅ Правильная структура транзакции с динамическим gas pricing
      const txParams = {
        to: quote.transactionRequest.to as `0x${string}`,
        data: quote.transactionRequest.data as `0x${string}`,
        value: BigInt(quote.transactionRequest.value),
        gas: gasLimit,
        ...gasParams, // ✅ Используем EIP-1559 или legacy в зависимости от сети
        chainId: sourceChainId // Используем chainId исходной сети!
      }

      console.log('🚀 Отправляем транзакцию бриджа...')
      // Убираем техническую информацию - параметры транзакции

      // ✅ Дополнительные проверки безопасности перед отправкой
      const nonce = await publicClient.getTransactionCount({
        address: this.account.address,
        blockTag: 'pending'
      })
      console.log(`🔢 Nonce: ${nonce}`)

      // ✅ Отправка транзакции с дополнительными проверками
      const hash = await walletClient.sendTransaction({
        ...txParams,
        account: this.account,
        chain: walletClient.chain
      })

      // Получаем правильную ссылку на explorer исходной сети
      const networkKey = this.getNetworkKey(sourceNetwork)
      const explorerUrl = this.getExplorerUrl(networkKey, hash)

      console.log(`📤 Транзакция отправлена: ${explorerUrl}`)
      // Не используем logger.transaction для sent, так как он показывает неправильную ссылку

      // ✅ Ожидаем подтверждения транзакции
      logger.info('Ожидаем подтверждения...')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        console.log(`✅ Транзакция подтверждена: ${explorerUrl}`)
        // Логируем в файл с правильной ссылкой
        const details = `${this.account.address} - ${explorerUrl}`
        fileLogger.logTransaction(hash, true, 'WALLET_TOPUP', details)
        logger.info(`Использовано газа: ${receipt.gasUsed}`)
        return hash
      } else {
        throw new Error('Транзакция не удалась')
      }
    } catch (error) {
      // Упрощаем сообщение об ошибке
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      console.error('❌ Ошибка выполнения транзакции бриджа:', errorMessage)

      // ✅ Детальная обработка ошибок
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          throw new Error('Недостаточно средств для выполнения транзакции')
        } else if (error.message.includes('gas')) {
          throw new Error('Проблема с газом: ' + error.message)
        } else if (error.message.includes('revert')) {
          throw new Error('Транзакция отменена: ' + error.message)
        } else {
          throw new Error('Ошибка транзакции: ' + error.message)
        }
      }
      throw error
    }
  }

  /**
   * Получает ключ сети для маппинга explorer
   */
  private getNetworkKey (sourceNetwork: string): string {
    const networkMapping: Record<string, string> = {
      'Arbitrum One(ARB)': 'ARB',
      'Optimism(OP)': 'OP',
      'BASE': 'BASE'
    }

    return networkMapping[sourceNetwork] || 'UNKNOWN'
  }

  /**
   * Получает explorer URL для сети
   */
  private getExplorerUrl (networkName: string, txHash: string): string {
    const networkMapping: Record<string, string> = {
      'ARB': 'arbiscan.io',
      'OP': 'optimistic.etherscan.io',
      'BASE': 'basescan.org'
    }

    const mappedNetwork = networkMapping[networkName.toUpperCase()]
    if (mappedNetwork) {
      return `https://${mappedNetwork}/tx/${txHash}`
    }

    // Fallback на Soneium explorer
    return `https://soneium.blockscout.com/tx/${txHash}`
  }

  /**
   * Получает chain ID по имени сети
   */
  private getChainIdByName (networkName: string): number {
    // Маппинг названий сетей от MEXC к внутренним названиям
    const networkMapping: Record<string, string> = {
      'ARBITRUM ONE(ARB)': 'ARB',
      'OPTIMISM(OP)': 'OP',
      'BASE': 'BASE'
    }

    const mappedNetwork = networkMapping[networkName.toUpperCase()] || networkName.toUpperCase()

    const chainIds: Record<string, number> = {
      'ARB': 42161,
      'OP': 10,
      'BASE': 8453
    }

    const chainId = chainIds[mappedNetwork] || 1
    console.log(`🔗 Chain ID для "${networkName}" -> "${mappedNetwork}": ${chainId}`)
    return chainId
  }

  /**
   * Загружает конфигурацию MEXC из файла
   */
  private async loadMEXCConfig (): Promise<{ apiKey: string; secretKey: string; baseUrl: string; timeout?: number; recvWindow?: number }> {
    try {
      const fs = await import('fs')
      const path = await import('path')

      const configPath = path.join(process.cwd(), 'mexc_api.txt')

      if (!fs.existsSync(configPath)) {
        throw new Error('Файл mexc_api.txt не найден. Создайте файл с API ключами MEXC в формате:\napiKey=your_api_key\nsecretKey=your_secret_key')
      }

      const configContent = fs.readFileSync(configPath, 'utf8')
      const lines = configContent.split('\n').filter(line => line.trim() && !line.startsWith('#'))

      let apiKey = ''
      let secretKey = ''

      for (const line of lines) {
        const [key, value] = line.split('=').map(s => s.trim())
        if (key === 'apiKey' && value) {
          apiKey = value
        } else if (key === 'secretKey' && value) {
          secretKey = value
        }
      }

      if (!apiKey || !secretKey) {
        throw new Error('Не найдены apiKey или secretKey в файле mexc_api.txt')
      }

      return {
        apiKey,
        secretKey,
        baseUrl: 'https://api.mexc.com',
        timeout: 30000,
        recvWindow: 5000
      }
    } catch (error) {
      console.error('❌ Ошибка загрузки конфигурации MEXC:', error)
      throw new Error(`Не удалось загрузить конфигурацию MEXC: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }

  /**
   * Выполняет вывод с MEXC
   */
  private async performMEXCWithdraw (amountETH: number, targetNetwork: string): Promise<{ success: boolean; withdrawId?: string; error?: string }> {
    try {
      console.log(`🏦 Выполняем вывод ${amountETH} ETH с MEXC в ${targetNetwork}...`)

      // Получаем конфигурацию MEXC из файла
      const mexcConfig = await this.loadMEXCConfig()

      // Создаем экземпляр MEXC клиента
      const mexcClient = new MEXCWithdraw(mexcConfig)

      // Проверяем доступность средств
      const isAvailable = await mexcClient.checkWithdrawAvailability(amountETH)
      if (!isAvailable) {
        throw new Error('Недостаточно средств на MEXC для вывода')
      }

      // Проверяем минимальную сумму
      const isValidAmount = await mexcClient.checkMinimumWithdrawAmount(amountETH)
      if (!isValidAmount) {
        throw new Error('Сумма меньше минимальной для вывода')
      }

      // Выполняем вывод
      const withdrawRequest = {
        coin: 'ETH',
        address: this.account.address,
        amount: amountETH,
        network: targetNetwork
      }

      const result = await mexcClient.withdraw(withdrawRequest)
      console.log(`✅ Вывод выполнен успешно! ID: ${result.id}`)

      return { success: true, withdrawId: result.id }
    } catch (error) {
      console.error('❌ Ошибка вывода MEXC:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Неизвестная ошибка' }
    }
  }

  /**
   * Проверка цены газа в ETH mainnet
   */
  private async checkGasPrice (gasChecker?: GasChecker): Promise<void> {
    if (!gasChecker) return

    try {
      if (await gasChecker.isGasPriceTooHigh()) {
        console.log('\n⛽ Проверка цены газа...')
        await gasChecker.waitForGasPriceToDrop()
      }
    } catch (error) {
      console.error('❌ Ошибка проверки газа:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      // Продолжаем работу даже при ошибке проверки газа
    }
  }

  /**
   * Основная функция пополнения кошелька
   */
  async performTopup (config: TopupConfig, gasChecker?: GasChecker): Promise<TopupResult> {
    try {
      console.log(`\n💎 ПОПОЛНЕНИЕ КОШЕЛЬКА: ${this.account.address}`)
      console.log('='.repeat(60))

      // 🆕 Проверка цены газа в ETH mainnet
      await this.checkGasPrice(gasChecker)

      // 1. Получаем цену ETH
      const ethPrice = await this.fetchETHPrice()

      // 2. Генерируем случайную сумму в USD
      const randomUSD = this.generateRandomAmount(config.minAmountUSD, config.maxAmountUSD)
      console.log(`💵 Сгенерированная сумма: $${randomUSD.toFixed(2)}`)

      // 3. Конвертируем в ETH
      const ethAmount = this.convertUSDToETH(randomUSD, ethPrice)
      console.log(`🪙 Сумма в ETH: ${ethAmount.toFixed(6)} ETH`)

      // 4. Проверяем текущий баланс в Soneium
      const currentBalance = await this.getSoneiumETHBalance()
      console.log(`💰 Текущий баланс Soneium: ${currentBalance.toFixed(6)} ETH`)

      // 5. Проверяем, достаточно ли уже ETH в Soneium
      if (currentBalance >= ethAmount) {
        console.log(`✅ В Soneium уже достаточно ETH (${currentBalance.toFixed(6)} >= ${ethAmount.toFixed(6)})`)
        console.log('🎉 Пополнение не требуется!')

        return {
          success: true,
          walletAddress: this.account.address,
          strategy: 'sufficient',
          amountUSD: randomUSD,
          amountETH: ethAmount.toString()
        }
      }

      // 6. Проверяем балансы в других сетях
      console.log('🔍 Проверяем балансы в других сетях...')
      const otherBalances = await this.checkOtherNetworksBalances()

      // 7. Выбираем стратегию
      const strategy = this.selectTopupStrategy(otherBalances, ethAmount)
      // Убираем техническую информацию - стратегия

      let result: TopupResult

      if (strategy === 'search') {
        // Стратегия поиска и бриджа
        const bestNetwork = otherBalances.find(b => b.balance >= ethAmount)
        if (!bestNetwork) {
          const availableBalances = otherBalances.map(b => `${b.network}: ${b.balance.toFixed(6)} ETH`).join(', ')
          throw new Error(`Не найдено сети с достаточным балансом для бриджа ${ethAmount} ETH. Доступные балансы: ${availableBalances}`)
        }

        console.log(`🌐 Используем сеть: ${bestNetwork.network} (баланс: ${bestNetwork.balance} ETH)`)

        // Динамически рассчитываем оптимальную сумму для бриджа (заданная сумма минус газ)
        const bridgeAmount = await this.calculateOptimalBridgeAmount(bestNetwork.network, ethAmount)
        console.log(`🌉 Сумма для бриджа: ${bridgeAmount.toFixed(6)} ETH`)

        const bridgeResult = await this.performBridgeWithRetry(bestNetwork.network, bridgeAmount, gasChecker)

        result = {
          success: bridgeResult.success,
          walletAddress: this.account.address,
          strategy: 'search',
          sourceNetwork: bestNetwork.network,
          amountUSD: randomUSD,
          amountETH: bridgeAmount.toString(), // Фактическая сумма бриджа
          bridgeTxHash: bridgeResult.txHash,
          error: bridgeResult.error
        }
      } else {
        // Стратегия вывода и бриджа
        const targetNetworks = ['ARB', 'OP', 'BASE']

        // Выбираем подходящую сеть с учетом минимальной суммы вывода
        const randomNetwork = await this.selectSuitableNetworkForWithdraw(ethAmount, targetNetworks)
        console.log(`🎲 Выбрана подходящая сеть для вывода: ${randomNetwork}`)

        // Выполняем вывод с MEXC
        const withdrawResult = await this.performMEXCWithdraw(ethAmount, randomNetwork)

        if (!withdrawResult.success) {
          throw new Error(`Ошибка вывода MEXC: ${withdrawResult.error}`)
        }

        // Ожидаем поступления средств перед бриджем (с учетом комиссии MEXC)
        console.log(`⏳ Ожидаем поступления средств на ${randomNetwork}...`)

        // Получаем реальную комиссию MEXC для выбранной сети через API
        const mexcConfig = await this.loadMEXCConfig()
        const mexcClient = new MEXCWithdraw(mexcConfig)
        const networks = await mexcClient.getWithdrawNetworks()
        const selectedNetworkConfig = networks.find(n => n.network === randomNetwork)

        if (!selectedNetworkConfig) {
          throw new Error(`Не удалось найти конфигурацию сети ${randomNetwork} в MEXC API`)
        }

        const mexcFee = selectedNetworkConfig.fee
        console.log(`💰 Реальная комиссия MEXC для ${randomNetwork}: ${mexcFee} ETH`)

        // Рассчитываем ожидаемую сумму с учетом реальной комиссии MEXC
        const expectedAmount = ethAmount - mexcFee
        console.log(`📊 Ожидаемая сумма после комиссии: ${expectedAmount.toFixed(6)} ETH`)

        const balanceUpdated = await this.waitForBalanceUpdate(randomNetwork, expectedAmount)

        if (!balanceUpdated) {
          throw new Error(`Средства не поступили на ${randomNetwork} в течение ожидаемого времени`)
        }

        // Добавляем задержку после поступления средств с MEXC для естественности
        const delaySeconds = Math.round(GAS_CONFIG.MEXC_WITHDRAW_DELAY_MS / 1000)
        console.log(`⏳ Ожидаем ${delaySeconds} секунд после поступления средств с MEXC...`)
        await new Promise(resolve => setTimeout(resolve, GAS_CONFIG.MEXC_WITHDRAW_DELAY_MS))
        console.log('✅ Задержка завершена, продолжаем бридж')

        // Динамически рассчитываем оптимальную сумму для бриджа (ожидаемая сумма минус газ)
        const bridgeAmount = await this.calculateOptimalBridgeAmount(randomNetwork, expectedAmount)
        console.log(`🌉 Сумма для бриджа: ${bridgeAmount.toFixed(6)} ETH`)

        const bridgeResult = await this.performBridgeWithRetry(randomNetwork, bridgeAmount, gasChecker)

        result = {
          success: bridgeResult.success,
          walletAddress: this.account.address,
          strategy: 'withdraw',
          sourceNetwork: randomNetwork,
          amountUSD: randomUSD,
          amountETH: bridgeAmount.toString(), // Фактическая сумма бриджа
          mexcWithdrawId: withdrawResult.withdrawId,
          bridgeTxHash: bridgeResult.txHash,
          error: bridgeResult.error
        }
      }

      if (result.success) {
        console.log('✅ Пополнение выполнено успешно!')
        console.log(`💰 Сумма: $${result.amountUSD.toFixed(2)} (${result.amountETH} ETH)`)
        if (result.mexcWithdrawId) {
          console.log(`🏦 MEXC ID: ${result.mexcWithdrawId}`)
        }
        if (result.bridgeTxHash) {
          console.log(`🌉 Bridge TX: ${result.bridgeTxHash}`)
        }
      } else {
        console.log(`❌ Ошибка пополнения: ${result.error}`)
      }

      return result
    } catch (error) {
      // Детальная обработка различных типов ошибок
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('недостаточно средств')) {
          errorMessage = `Недостаточно средств: ${error.message}`
        } else if (error.message.includes('минимальная')) {
          errorMessage = `Проблема с минимальной суммой: ${error.message}`
        } else if (error.message.includes('средства не поступили')) {
          errorMessage = `Проблема с поступлением средств: ${error.message}`
        } else if (error.message.includes('бридж')) {
          errorMessage = `Ошибка бриджа: ${error.message}`
        } else {
          errorMessage = error.message
        }
      }

      console.error('❌ Критическая ошибка пополнения:', errorMessage)

      return {
        success: false,
        walletAddress: this.account.address,
        strategy: 'search',
        amountUSD: 0,
        amountETH: '0',
        error: errorMessage
      }
    }
  }
}

/**
 * Основная функция модуля пополнения
 */
export async function performWalletTopup (privateKey: `0x${string}`, config: TopupConfig, gasChecker?: GasChecker): Promise<TopupResult> {
  try {
    logger.moduleStart('Wallet Topup')

    const topup = new WalletTopup(privateKey)
    const result = await topup.performTopup(config, gasChecker)

    if (result.success) {
      logger.moduleEnd('Wallet Topup', true)
    } else {
      logger.moduleEnd('Wallet Topup', false)
    }

    return result
  } catch (error) {
    logger.moduleEnd('Wallet Topup', false)
    logger.error('Критическая ошибка модуля пополнения', error)
    return {
      success: false,
      walletAddress: privateKeyToAccount(privateKey).address,
      strategy: 'search',
      amountUSD: 0,
      amountETH: '0',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
