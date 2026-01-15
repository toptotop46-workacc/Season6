import axios, { type AxiosInstance } from 'axios'
import * as crypto from 'crypto'

/**
 * Конфигурация MEXC
 */
interface MEXCConfig {
  apiKey: string
  secretKey: string
  baseUrl: string
  timeout?: number
  recvWindow?: number
}

/**
 * Запрос на вывод средств
 */
interface WithdrawRequest {
  coin: string
  address: string
  amount: number
  network: string
  memo?: string
}

/**
 * Ответ на вывод средств
 */
interface MEXCWithdrawResponse {
  id: string
  coin: string
  address: string
  amount: number
  network: string
  status: string
  txId?: string | undefined
}

/**
 * Конфигурация сетей для вывода
 */
interface NetworkConfig {
  name: string
  network: string
  chainId: number
  withdrawMin: number
  withdrawMax: number
  fee: number
}

/**
 * Класс для работы с MEXC API
 */
export class MEXCWithdraw {
  private client: AxiosInstance
  private config: MEXCConfig

  constructor (config: MEXCConfig) {
    this.config = {
      ...config,
      recvWindow: config.recvWindow || 10000 // Увеличиваем окно по умолчанию
    }
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout || 30000
    })
  }

  /**
   * Генерирует подпись для MEXC API
   */
  private generateSignature (params: Record<string, unknown>): string {
    const queryString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&')

    const signature = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(queryString)
      .digest('hex')
    return signature
  }

  /**
   * Получает серверное время MEXC для синхронизации
   */
  private async getServerTime (): Promise<number> {
    try {
      const response = await this.client.get('/api/v3/time')
      return response.data.serverTime
    } catch {
      console.log('⚠️ Не удалось получить серверное время, используем локальное')
      return Date.now()
    }
  }

  /**
   * Выполняет подписанный запрос к MEXC API
   */
  private async signedRequest (
    method: 'GET' | 'POST',
    endpoint: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    // Получаем серверное время для синхронизации
    const serverTime = await this.getServerTime()
    const recvWindow = this.config.recvWindow || 10000 // Увеличиваем окно до 10 секунд

    const requestParams: Record<string, unknown> = {
      ...params,
      timestamp: serverTime,
      recvWindow
    }

    const signature = this.generateSignature(requestParams)
    const queryString = Object.keys(requestParams)
      .sort()
      .map(key => `${key}=${requestParams[key]}`)
      .join('&')

    const url = `${endpoint}?${queryString}&signature=${signature}`

    try {
      const response = await this.client.request({
        method,
        url,
        headers: {
          'X-MEXC-APIKEY': this.config.apiKey,
          'Content-Type': 'application/json'
        }
      })

      return response.data
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { data?: unknown; status?: number; statusText?: string } }

        // Специальная обработка ошибки времени
        if (axiosError.response?.data && typeof axiosError.response.data === 'object') {
          const errorData = axiosError.response.data as { code?: number; msg?: string }
          if (errorData.code === 700003) {
            console.error('🕐 Ошибка синхронизации времени! Попробуйте увеличить recvWindow или проверить системное время')
          }
        }
      }

      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      console.error(`❌ MEXC API ошибка: ${errorMessage}`)
      throw new Error(`MEXC API ошибка: ${errorMessage}`)
    }
  }

  /**
   * Получает баланс аккаунта
   */
  async getAccountBalance (): Promise<unknown> {
    console.log('💰 Получаю баланс аккаунта MEXC...')
    return await this.signedRequest('GET', '/api/v3/account')
  }

  /**
   * Получает доступные сети для вывода ETH
   */
  async getWithdrawNetworks (): Promise<NetworkConfig[]> {
    console.log('🌐 Получаю доступные сети для вывода...')
    const response = await this.signedRequest('GET', '/api/v3/capital/config/getall')

    // Проверяем структуру ответа
    if (!response || !Array.isArray(response)) {
      console.error('❌ Неверный формат ответа от MEXC API')
      throw new Error('Неверный формат ответа от MEXC API')
    }

    // Ищем ETH в списке монет
    const ethConfig = response.find((config: { coin: string }) => config.coin === 'ETH')

    if (!ethConfig) {
      console.log('⚠️ ETH конфигурация не найдена, используем дефолтную')
      return this.getDefaultETHNetworks()
    }

    if (!ethConfig.networkList || !Array.isArray(ethConfig.networkList)) {
      console.error('❌ networkList не найден или не является массивом')
      return this.getDefaultETHNetworks()
    }

    // Фильтруем нежелательные сети (исключаем MORPH, LINEA и другие неподдерживаемые сети)
    const supportedNetworks = ['ARB', 'OP', 'BASE']

    return ethConfig.networkList
      .filter((network: { network: string }) => {
        const networkName = network.network.toUpperCase()
        return supportedNetworks.some(supported => networkName.includes(supported))
      })
      .map((network: { network: string; withdrawMin: string; withdrawMax: string; withdrawFee: string; chainId?: string }) => ({
        name: network.network,
        network: network.network,
        chainId: network.chainId ? parseInt(network.chainId) : this.getDefaultChainId(network.network),
        withdrawMin: parseFloat(network.withdrawMin),
        withdrawMax: parseFloat(network.withdrawMax),
        fee: parseFloat(network.withdrawFee)
      }))
  }

  /**
   * Возвращает дефолтную конфигурацию сетей для ETH
   */
  private getDefaultETHNetworks (): NetworkConfig[] {
    return [
      {
        name: 'Arbitrum One(ARB)',
        network: 'Arbitrum One(ARB)',
        chainId: 42161,
        withdrawMin: 0.001,
        withdrawMax: 10.0,
        fee: 0.00004 // Дефолтная комиссия (будет заменена реальной из API)
      },
      {
        name: 'Optimism(OP)',
        network: 'Optimism(OP)',
        chainId: 10,
        withdrawMin: 0.0003,
        withdrawMax: 10.0,
        fee: 0.000005 // Дефолтная комиссия (будет заменена реальной из API)
      },
      {
        name: 'BASE',
        network: 'BASE',
        chainId: 8453,
        withdrawMin: 0.003,
        withdrawMax: 10.0,
        fee: 0.0000109 // Дефолтная комиссия (будет заменена реальной из API)
      }
    ]
  }

  /**
   * Получает chainId по умолчанию для известных сетей
   */
  private getDefaultChainId (networkName: string): number {
    const chainIdMap: Record<string, number> = {
      'ARBITRUM ONE(ARB)': 42161,
      'OPTIMISM(OP)': 10,
      'BASE': 8453
    }
    return chainIdMap[networkName] || 1 // Ethereum mainnet по умолчанию
  }

  /**
   * Выполняет вывод средств
   */
  async withdraw (request: WithdrawRequest): Promise<MEXCWithdrawResponse> {
    console.log(`🚀 Выполняю вывод ${request.amount} ${request.coin} на ${request.address} (${request.network})...`)

    // Маппинг полных названий сетей на внутренние названия для MEXC API
    const networkMapping: Record<string, string> = {
      'Arbitrum One(ARB)': 'ARB',
      'Optimism(OP)': 'OP',
      'BASE': 'BASE'
    }

    const internalNetwork = networkMapping[request.network] || request.network
    console.log(`🔗 Маппинг сети: "${request.network}" -> "${internalNetwork}"`)

    const withdrawParams = {
      coin: request.coin,
      address: request.address,
      amount: request.amount,
      netWork: internalNetwork, // Используем внутреннее название для MEXC API
      ...(request.memo && { memo: request.memo })
    }

    const response = await this.signedRequest('POST', '/api/v3/capital/withdraw', withdrawParams)

    console.log(`✅ Вывод выполнен успешно! ID: ${(response as { id: string }).id}`)

    return {
      id: (response as { id: string }).id,
      coin: (response as { coin: string }).coin,
      address: (response as { address: string }).address,
      amount: (response as { amount: number }).amount,
      network: (response as { netWork: string }).netWork,
      status: (response as { status: string }).status,
      txId: (response as { txId?: string }).txId ?? undefined
    }
  }

  /**
   * Проверяет доступность средств для вывода
   */
  async checkWithdrawAvailability (minAmount: number): Promise<boolean> {
    try {
      const balance = await this.getAccountBalance()

      // Проверяем структуру ответа
      if (!balance || typeof balance !== 'object') {
        console.error('❌ Неверный формат ответа баланса')
        return false
      }

      const balanceData = balance as { balances?: Array<{ asset: string; free: string; locked?: string }> }

      if (!balanceData.balances || !Array.isArray(balanceData.balances)) {
        console.error('❌ Поле balances не найдено или не является массивом')
        return false
      }

      const ethBalance = balanceData.balances.find((b) => b.asset === 'ETH')

      if (!ethBalance) {
        console.log('❌ ETH баланс не найден в списке активов')
        return false
      }

      const freeBalance = parseFloat(ethBalance.free)
      const isAvailable = freeBalance >= minAmount

      console.log(`💰 ETH баланс: ${freeBalance} ETH, требуется: ${minAmount} ETH`)
      console.log(`✅ Средства ${isAvailable ? 'доступны' : 'недоступны'} для вывода`)

      return isAvailable
    } catch (error) {
      console.error('❌ Ошибка при проверке доступности средств:', error)

      if (error instanceof Error) {
        console.error(`💥 Детали ошибки: ${error.message}`)
        console.error(`📚 Stack trace: ${error.stack}`)
      }

      return false
    }
  }

  /**
   * Проверяет минимальную сумму для вывода для конкретной сети
   */
  async checkMinimumWithdrawAmount (amount: number, networkName?: string): Promise<boolean> {
    try {
      const networks = await this.getWithdrawNetworks()

      // Если указана конкретная сеть, проверяем её
      if (networkName) {
        const targetNetwork = networks.find(n => n.network === networkName)
        if (!targetNetwork) {
          console.log(`❌ Сеть ${networkName} не найдена в доступных для вывода`)
          return false
        }
        const isValid = amount >= targetNetwork.withdrawMin
        // Убираем техническую информацию - проверка сумм
        return isValid
      }

      // Если сеть не указана, проверяем минимальную сумму среди всех доступных сетей
      const minAmount = Math.min(...networks.map(n => n.withdrawMin))
      const isValid = amount >= minAmount
      // Убираем техническую информацию - минимальная сумма

      return isValid
    } catch (error) {
      console.error('❌ Ошибка при проверке минимальной суммы:', error)

      if (error instanceof Error) {
        console.error(`💥 Детали ошибки: ${error.message}`)
        console.error(`📚 Stack trace: ${error.stack}`)
      }

      return false
    }
  }

  /**
   * Выбирает случайную сеть из доступных (теперь асинхронный метод)
   */
  async selectRandomNetwork (): Promise<NetworkConfig> {
    const networks = await this.getWithdrawNetworks()
    if (networks.length === 0) {
      throw new Error('Нет доступных сетей для вывода')
    }

    const randomIndex = Math.floor(Math.random() * networks.length)
    return networks[randomIndex]!
  }

  /**
   * Генерирует случайную сумму для вывода
   */
  static generateRandomAmount (min: number, max: number): number {
    return Math.random() * (max - min) + min
  }
}

/**
 * Утилитарная функция для быстрого вывода
 */
export async function performMEXCWithdraw (
  config: MEXCConfig,
  walletAddress: string,
  amount: number,
  targetNetwork?: string
): Promise<MEXCWithdrawResponse | null> {
  try {
    const mexc = new MEXCWithdraw(config)

    // Проверяем доступность средств
    const isAvailable = await mexc.checkWithdrawAvailability(amount)
    if (!isAvailable) {
      throw new Error('Недостаточно средств для вывода')
    }

    // Если сеть не указана, выбираем случайную
    let selectedNetwork = targetNetwork
    if (!selectedNetwork) {
      const randomNetwork = await mexc.selectRandomNetwork()
      selectedNetwork = randomNetwork.network
    }

    // Проверяем минимальную сумму для выбранной сети
    const isValidAmount = await mexc.checkMinimumWithdrawAmount(amount, selectedNetwork)
    if (!isValidAmount) {
      throw new Error(`Сумма ${amount} меньше минимальной для сети ${selectedNetwork}`)
    }

    // Выполняем вывод
    const withdrawRequest: WithdrawRequest = {
      coin: 'ETH',
      address: walletAddress,
      amount: amount,
      network: selectedNetwork
    }

    return await mexc.withdraw(withdrawRequest)
  } catch (error) {
    console.error('❌ Ошибка вывода MEXC:', error)
    return null
  }
}
