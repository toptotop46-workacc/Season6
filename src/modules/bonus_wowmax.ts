import { parseEther, formatEther, formatUnits, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeSendTransaction } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import axios from 'axios'

// Адреса контрактов на Soneium
const USDC_E_ADDRESS = '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369' as `0x${string}`

// Конфигурация
const API_BASE_URL = 'https://portal.soneium.org/api'
const WOWMAX_QUEST_ID = 'wowmax_6'
const WOWMAX_API_BASE = 'https://api-gateway.wowmax.exchange'
const NATIVE_ETH_SYMBOL = 'ETH'
const CHAIN_ID = 1868
const SLIPPAGE_TOLERANCE = 1.0 // 1%
const MIN_BALANCE_ETH = parseEther('0.0001') // Минимальный баланс для свапа
const MIN_SWAP_AMOUNT_ETH = parseEther('0.000001') // Минимальная сумма свапа

// Конфигурация retry
const MAX_RETRY_ATTEMPTS = 10
const RETRY_DELAY_MS = 2000
const API_TIMEOUT_MS = 30000

const proxyManager = ProxyManager.getInstance()
const publicClient = rpcManager.createPublicClient(soneiumChain)

// Интерфейс для ответа WOWMAX API
interface WowmaxSwapResponse {
  contract: string
  data: string
  value?: string
  amountOut?: string[]
  gasUnitsConsumed?: string
}

/**
 * Проверяет статус квеста WOWMAX
 */
async function checkWowmaxQuestStatus (address: string): Promise<{ isCompleted: boolean; progress: string } | null> {
  try {
    const proxy = proxyManager.getRandomProxyFast()
    if (!proxy) return null

    const proxyAgents = proxyManager.createProxyAgents(proxy)
    const axiosInstance = axios.create({
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json'
      },
      httpsAgent: proxyAgents.httpsAgent,
      httpAgent: proxyAgents.httpAgent
    })

    const response = await axiosInstance.get(`${API_BASE_URL}/profile/bonus-dapp?address=${address}`)
    const bonusData = response.data

    if (!Array.isArray(bonusData)) return null

    const wowmaxQuest = bonusData
      .filter((item: { season: number; id: string }) => item.season === 6)
      .find((item: { id: string }) => item.id === WOWMAX_QUEST_ID)

    if (!wowmaxQuest) return null

    const totalCompleted = wowmaxQuest.quests.reduce((sum: number, q: { completed: number }) => sum + q.completed, 0)
    const totalRequired = wowmaxQuest.quests.reduce((sum: number, q: { required: number }) => sum + q.required, 0)

    return {
      isCompleted: totalCompleted >= totalRequired,
      progress: `${totalCompleted}/${totalRequired}`
    }
  } catch {
    return null
  }
}

/**
 * Получает баланс ETH кошелька
 */
async function getEthBalance (address: `0x${string}`): Promise<bigint> {
  return await publicClient.getBalance({ address })
}

/**
 * Рассчитывает сумму свапа (0.1% - 1% от баланса)
 */
function calculateSwapAmount (balance: bigint): bigint {
  // Генерируем случайный процент от 0.1% до 1%
  // Math.random() возвращает 0-1, умножаем на 0.9 чтобы получить 0-0.9, добавляем 0.1 чтобы получить 0.1-1.0
  const percentage = Math.random() * 0.9 + 0.1 // 0.1 - 1.0 (это проценты: 0.1% - 1%)

  // Вычисляем сумму свапа: balance * percentage / 100
  // percentage = 0.1 означает 0.1%, percentage = 1.0 означает 1%
  // Для точных вычислений с BigInt:
  // 0.1% = balance * 0.001 = balance / 1000 = (balance * 100) / 100000
  // 1% = balance * 0.01 = balance / 100 = (balance * 1000) / 100000
  // Поэтому percentageInParts должно быть от 100 до 1000
  const percentageInParts = Math.floor(percentage * 1000) // От 100 (0.1%) до 1000 (1%)
  const swapAmount = (balance * BigInt(percentageInParts)) / BigInt(100000)

  // Проверяем, что сумма не меньше минимальной
  // Если рассчитанная сумма меньше минимальной, используем минимальную
  // Но только если она не превышает 1% от баланса
  const onePercentOfBalance = balance / BigInt(100)
  if (swapAmount < MIN_SWAP_AMOUNT_ETH) {
    // Если минимальная сумма больше 1% от баланса, используем 1% от баланса
    if (MIN_SWAP_AMOUNT_ETH > onePercentOfBalance) {
      return onePercentOfBalance
    }
    return MIN_SWAP_AMOUNT_ETH
  }

  return swapAmount
}

/**
 * Получает данные для свапа через WOWMAX API с прокси
 */
async function getSwapDataFromWOWMAXAPI (
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippageTolerance: number,
  traderAddress: string,
  proxy: import('../proxy-manager.js').ProxyConfig
): Promise<WowmaxSwapResponse> {
  try {
    // Формируем URL с query параметрами
    const url = new URL(`${WOWMAX_API_BASE}/chains/${chainId}/swap`)
    url.searchParams.set('from', tokenIn)
    url.searchParams.set('to', tokenOut)
    url.searchParams.set('amount', amountIn)
    url.searchParams.set('slippage', slippageTolerance.toString())
    url.searchParams.set('trader', traderAddress)

    logger.info('📡 Запрос данных для свапа к WOWMAX API через прокси...')

    // Создаем axios instance с прокси
    const proxyAgents = proxyManager.createProxyAgents(proxy)
    const axiosInstance = axios.create({
      timeout: API_TIMEOUT_MS,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      httpsAgent: proxyAgents.httpsAgent,
      httpAgent: proxyAgents.httpAgent
    })

    const response = await axiosInstance.get(url.toString())

    if (response.status !== 200) {
      throw new Error(`API ошибка (${response.status}): ${JSON.stringify(response.data)}`)
    }

    const swapData = response.data as WowmaxSwapResponse

    // Валидация ответа
    if (!swapData.data) {
      throw new Error('Ответ API не содержит data для транзакции')
    }

    if (!swapData.contract) {
      throw new Error('Ответ API не содержит contract (адрес роутера)')
    }

    logger.info('✅ Данные для свапа получены от WOWMAX API')

    return swapData
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.warn(`❌ Ошибка при получении данных для свапа: ${errorMessage}`)
    throw error
  }
}

/**
 * Получает данные свапа с retry-логикой и ротацией прокси
 */
async function getSwapDataFromWOWMAXAPIWithRetry (
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippageTolerance: number,
  traderAddress: string
): Promise<WowmaxSwapResponse> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      // Получаем новый прокси для каждой попытки
      const proxy = proxyManager.getRandomProxyFast()
      if (!proxy) {
        throw new Error('Нет доступных прокси')
      }

      logger.info(`🔄 Попытка ${attempt}/${MAX_RETRY_ATTEMPTS} получения данных свапа...`)

      const swapData = await getSwapDataFromWOWMAXAPI(
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        slippageTolerance,
        traderAddress,
        proxy
      )

      // Успешно получили данные
      return swapData
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Неизвестная ошибка')
      logger.warn(`⚠️  Попытка ${attempt}/${MAX_RETRY_ATTEMPTS} неудачна: ${lastError.message}`)

      // Задержка между попытками (кроме последней)
      if (attempt < MAX_RETRY_ATTEMPTS) {
        logger.info(`⏳ Ожидание ${RETRY_DELAY_MS}мс перед следующей попыткой...`)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }
  }

  // Все попытки неудачны
  throw new Error(`Не удалось получить данные свапа после ${MAX_RETRY_ATTEMPTS} попыток. Последняя ошибка: ${lastError?.message}`)
}

/**
 * Выполняет свап ETH → USDC.e через WOWMAX
 */
async function performWowmaxSwap (
  privateKey: `0x${string}`,
  amountIn: bigint
): Promise<{ success: boolean; hash?: `0x${string}`; error?: string }> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const amountInETH = formatEther(amountIn)
    logger.info(`Выполняем свап ${amountInETH} ETH → USDC.e через WOWMAX`)

    // Получаем данные для свапа через WOWMAX API с retry-логикой
    const swapData = await getSwapDataFromWOWMAXAPIWithRetry(
      CHAIN_ID,
      NATIVE_ETH_SYMBOL,
      USDC_E_ADDRESS,
      amountInETH,
      SLIPPAGE_TOLERANCE,
      account.address
    )

    // Извлекаем данные из ответа API
    const routerAddress = getAddress(swapData.contract)
    const calldata = swapData.data as `0x${string}`
    const value = swapData.value ? BigInt(swapData.value) : amountIn
    const amountOut = swapData.amountOut ? swapData.amountOut[swapData.amountOut.length - 1] : null
    const gasEstimate = swapData.gasUnitsConsumed ? BigInt(swapData.gasUnitsConsumed) : undefined

    // Логирование ожидаемого выхода
    if (amountOut) {
      const amountOutBigInt = BigInt(amountOut)
      logger.info(`📈 Ожидаемое количество USDC.e: ${formatUnits(amountOutBigInt, 6)} USDC.e`)
    }

    logger.info('🚀 Отправка транзакции свапа...')
    logger.info(`   Свап: ${amountInETH} ETH -> USDC.e`)
    logger.info(`   Роутер: ${routerAddress}`)
    logger.info(`   Value: ${formatEther(value)} ETH`)

    // Оценка газа, если не предоставлена API
    let finalGasEstimate: bigint | undefined = gasEstimate
    if (!finalGasEstimate) {
      try {
        finalGasEstimate = await publicClient.estimateGas({
          account,
          to: routerAddress,
          data: calldata,
          value: value
        })
        logger.info(`⛽ Оценка газа: ${finalGasEstimate.toString()}`)
      } catch {
        logger.warn('Не удалось оценить газ, используем стандартный лимит')
        finalGasEstimate = 300000n
      }
    }

    // Отправляем транзакцию
    const txResult = await safeSendTransaction(
      publicClient,
      walletClient,
      account.address,
      {
        to: routerAddress,
        data: calldata,
        value: value,
        gas: finalGasEstimate ? (finalGasEstimate * BigInt(120)) / BigInt(100) : undefined // Добавляем 20% запас
      }
    )

    if (!txResult.success) {
      return {
        success: false,
        error: txResult.error || 'Ошибка отправки транзакции'
      }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'BONUS_WOWMAX')

    // Ждем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'BONUS_WOWMAX', account.address)
      logger.success(`Транзакция подтверждена: https://soneium.blockscout.com/tx/${hash}`)
      return {
        success: true,
        hash
      }
    } else {
      logger.transaction(hash, 'failed', 'BONUS_WOWMAX', account.address)
      return {
        success: false,
        hash,
        error: 'Transaction reverted'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении свапа', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

/**
 * Выполняет Bonus WOWMAX модуль
 */
export async function performBonusWowmax (
  privateKey: `0x${string}`
): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  swapAmount?: string
  error?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.moduleStart('Bonus WOWMAX')
    logger.info(`Проверка статуса квеста для кошелька ${account.address}`)

    // Проверяем статус квеста
    const questStatus = await checkWowmaxQuestStatus(account.address)

    // Если не удалось получить данные, пропускаем аккаунт
    if (!questStatus) {
      logger.warn('Не удалось получить данные о статусе квеста, аккаунт пропускается')
      logger.moduleEnd('Bonus WOWMAX', true)
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: 'Не удалось получить данные о статусе квеста'
      }
    }

    logger.info(`Статус квеста WOWMAX: ${questStatus.progress}`)

    // Если квест выполнен, пропускаем аккаунт
    if (questStatus.isCompleted) {
      logger.success('Квест WOWMAX уже выполнен, транзакция не требуется')
      logger.moduleEnd('Bonus WOWMAX', true)
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: `Квест выполнен (${questStatus.progress})`
      }
    }

    // Квест не выполнен, выполняем свап
    logger.info('Квест не выполнен, выполняем свап ETH → USDC.e...')

    // Получаем баланс ETH
    const balance = await getEthBalance(account.address)
    const balanceETH = formatEther(balance)

    logger.info(`Баланс ETH: ${balanceETH} ETH`)

    // Проверяем минимальный баланс
    if (balance < MIN_BALANCE_ETH) {
      logger.warn(`Недостаточно ETH для свапа. Минимум: ${formatEther(MIN_BALANCE_ETH)} ETH`)
      logger.moduleEnd('Bonus WOWMAX', false)
      return {
        success: false,
        walletAddress: account.address,
        error: `Недостаточно ETH. Баланс: ${balanceETH} ETH, минимум: ${formatEther(MIN_BALANCE_ETH)} ETH`
      }
    }

    // Рассчитываем сумму свапа (0.1% - 1% от баланса)
    const swapAmount = calculateSwapAmount(balance)
    const swapAmountETH = formatEther(swapAmount)

    logger.info(`Сумма свапа: ${swapAmountETH} ETH (${((Number(swapAmount) / Number(balance)) * 100).toFixed(2)}% от баланса)`)

    // Выполняем свап
    const swapResult = await performWowmaxSwap(privateKey, swapAmount)

    if (swapResult.success && swapResult.hash) {
      logger.moduleEnd('Bonus WOWMAX', true)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: swapResult.hash,
        swapAmount: swapAmountETH
      }
    } else {
      logger.moduleEnd('Bonus WOWMAX', false)
      return {
        success: false,
        walletAddress: account.address,
        swapAmount: swapAmountETH,
        error: swapResult.error || 'Ошибка выполнения свапа'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении Bonus WOWMAX', error)
    logger.moduleEnd('Bonus WOWMAX', false)
    throw error
  }
}
