import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { privateKeyToAccount } from 'viem/accounts'
import { ProxyManager } from '../proxy-manager.js'
import axios from 'axios'
import { logger } from '../logger.js'

// Константы
const NFT_CONTRACT = '0xe5a3d28FE65895d7cd7146Fb50199b85fba74c3e' as `0x${string}`
const OPENSEA_GRAPHQL_URL = 'https://gql.opensea.io/graphql'
const API_BASE_URL = 'https://portal.soneium.org/api'
const MINT_PHASE1_START_DATE = new Date('2026-02-16T10:00:00+03:00') // 16 февраля 10:00 AM GMT+3 (Stage 1)
const MINT_PHASE2_START_DATE = new Date('2026-03-02T10:00:00+03:00') // 2 марта 10:00 AM GMT+3 (Stage 2, для кошельков с 80-83 поинтами)

// ABI для ERC721
const ERC721_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const

// GraphQL запрос для минта
const MINT_QUERY = `query MintActionTimelineQuery($address: Address!, $fromAssets: [AssetQuantityInput!]!, $toAssets: [AssetQuantityInput!]!, $recipient: Address) {
  swap(
    address: $address
    fromAssets: $fromAssets
    toAssets: $toAssets
    recipient: $recipient
    action: MINT
  ) {
    actions {
      __typename
      ... on TransactionAction {
        transactionSubmissionData {
          chain {
            networkId
            identifier
            __typename
          }
          to
          data
          value
          __typename
        }
        __typename
      }
      ... on MintAction {
        __typename
        collection {
          imageUrl
          __typename
        }
      }
    }
    errors {
      __typename
    }
    __typename
  }
}`

// Интерфейсы
interface Season6Data {
  totalScore: number
  isEligible: boolean
}

interface MintEligibilityResult {
  eligible: boolean
  phase?: 1 | 2
  reason: string
}

interface TransactionSubmissionData {
  to: string
  data: string
  value: string
  chain: {
    networkId: string
    identifier: string
  }
}

interface SeasonData {
  address: string
  baseScore: number
  bonusPoints: number
  season: number
  totalScore: number
  isEligible: boolean
  [key: string]: unknown
}

// User-Agents для запросов
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/121.0'
]

// Конфигурация для API запросов
const API_CONFIG = {
  timeout: 10000,
  retryAttempts: 10
}

const OPENSEA_CONFIG = {
  timeout: 30000,
  retryAttempts: 3
}

/**
 * Получает случайный User-Agent
 */
function getRandomUserAgent (): string {
  const randomIndex = Math.floor(Math.random() * USER_AGENTS.length)
  return USER_AGENTS[randomIndex]!
}

/**
 * Проверяет баланс NFT за 6 сезон
 */
async function checkSeason6NFTBalance (address: `0x${string}`): Promise<bigint> {
  try {
    const publicClient = rpcManager.createPublicClient(soneiumChain)
    const balance = await publicClient.readContract({
      address: NFT_CONTRACT,
      abi: ERC721_ABI,
      functionName: 'balanceOf',
      args: [address]
    })

    logger.info(`Баланс NFT Season 6: ${balance.toString()}`)
    return balance as bigint
  } catch (error) {
    logger.error('Ошибка при проверке баланса NFT', error)
    throw error
  }
}

/**
 * Получает данные сезона 6 через API
 */
async function getSeason6Points (address: string): Promise<Season6Data | null> {
  const proxyManager = ProxyManager.getInstance()
  let lastError = ''

  for (let attempt = 1; attempt <= API_CONFIG.retryAttempts; attempt++) {
    try {
      const proxy = proxyManager.getRandomProxyFast()
      if (!proxy) {
        throw new Error('Нет доступных прокси')
      }

      const axiosInstance = createApiAxiosInstance(proxy)
      const response = await axiosInstance.get(`${API_BASE_URL}/profile/calculator?address=${address}`)
      const data = response.data

      if (!Array.isArray(data) || data.length === 0) {
        logger.warn('API вернул пустой массив данных')
        return null
      }

      const season6Data = data.find((item: SeasonData) => item.season === 6)

      if (!season6Data) {
        logger.warn('Данные за сезон 6 не найдены')
        return null
      }

      logger.info(`Поинты сезона 6: ${season6Data.totalScore}/100, eligible: ${season6Data.isEligible}`)

      return {
        totalScore: season6Data.totalScore,
        isEligible: season6Data.isEligible
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      logger.warn(`Попытка ${attempt}/${API_CONFIG.retryAttempts} неудачна: ${lastError}`)

      if (attempt < API_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  logger.error(`Все ${API_CONFIG.retryAttempts} попыток получения данных сезона 6 неудачны. Последняя ошибка: ${lastError}`)
  return null
}

/**
 * Создает axios instance для API запросов с прокси
 */
function createApiAxiosInstance (proxy: import('../proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
  const proxyManager = ProxyManager.getInstance()
  const proxyAgents = proxyManager.createProxyAgents(proxy)
  const userAgent = getRandomUserAgent()

  return axios.create({
    timeout: API_CONFIG.timeout,
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive'
    },
    httpsAgent: proxyAgents.httpsAgent,
    httpAgent: proxyAgents.httpAgent
  })
}

/**
 * Проверяет доступность фазы 1 минта (Stage 1: 16 февраля 2026)
 */
function isMintPhase1Available (): boolean {
  const now = new Date()
  const isAvailable = now >= MINT_PHASE1_START_DATE
  logger.info(`Фаза 1 минта ${isAvailable ? 'доступна' : 'недоступна'} (дата начала: ${MINT_PHASE1_START_DATE.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })})`)
  return isAvailable
}

/**
 * Проверяет доступность фазы 2 минта (Stage 2: 2 марта 2026)
 */
function isMintPhase2Available (): boolean {
  const now = new Date()
  const isAvailable = now >= MINT_PHASE2_START_DATE
  logger.info(`Фаза 2 минта ${isAvailable ? 'доступна' : 'недоступна'} (дата начала: ${MINT_PHASE2_START_DATE.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })})`)
  return isAvailable
}

/**
 * Проверяет eligibility для минта
 */
function checkMintEligibility (totalScore: number): MintEligibilityResult {
  if (totalScore < 80) {
    return {
      eligible: false,
      reason: 'Минт будет доступен во 2 фазе'
    }
  }

  // Фаза 1: 84-100 поинтов (минт с 16 февраля 10:00 AM GMT+3)
  if (totalScore >= 84 && totalScore <= 100) {
    const phase1Available = isMintPhase1Available()
    if (phase1Available) {
      return {
        eligible: true,
        phase: 1,
        reason: 'Минт доступен сейчас (Фаза 1: 84-100 поинтов)'
      }
    } else {
      return {
        eligible: false,
        phase: 1,
        reason: `Минт будет доступен с 16 февраля 10:00 AM GMT+3. Текущие поинты: ${totalScore}/100`
      }
    }
  }

  // Фаза 2: 80-83 поинтов (минт с 2 марта 10:00 AM GMT+3)
  if (totalScore >= 80 && totalScore <= 83) {
    const phase2Available = isMintPhase2Available()
    if (phase2Available) {
      return {
        eligible: true,
        phase: 2,
        reason: 'Минт доступен сейчас (Фаза 2: 80-83 поинта)'
      }
    }
    const phase2DateStr = MINT_PHASE2_START_DATE.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Moscow'
    })
    const phase2TimeStr = MINT_PHASE2_START_DATE.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Moscow',
      timeZoneName: 'short'
    })
    return {
      eligible: false,
      phase: 2,
      reason: `Минт будет доступен с ${phase2DateStr} ${phase2TimeStr}. Поинты за 6 сезон: ${totalScore}/100`
    }
  }

  return {
    eligible: false,
    reason: `Неизвестный диапазон поинтов: ${totalScore}`
  }
}

/**
 * Получает данные транзакции минта из OpenSea GraphQL API через прокси
 */
async function getMintTransactionFromOpenSea (walletAddress: string): Promise<TransactionSubmissionData> {
  const proxyManager = ProxyManager.getInstance()
  let lastError = ''

  for (let attempt = 1; attempt <= OPENSEA_CONFIG.retryAttempts; attempt++) {
    try {
      const proxy = proxyManager.getRandomProxyFast()
      if (!proxy) {
        throw new Error('Нет доступных прокси')
      }

      const axiosInstance = createOpenSeaAxiosInstance(proxy)

      const variables = {
        address: walletAddress,
        fromAssets: [
          {
            asset: {
              chain: 'soneium',
              contractAddress: '0x0000000000000000000000000000000000000000' // Native token
            }
          }
        ],
        toAssets: [
          {
            asset: {
              chain: 'soneium',
              contractAddress: NFT_CONTRACT.toLowerCase(),
              tokenId: '0'
            },
            quantity: '1'
          }
        ]
      }

      logger.info(`Получение данных транзакции минта из OpenSea (попытка ${attempt}/${OPENSEA_CONFIG.retryAttempts})...`)

      const response = await axiosInstance.post(OPENSEA_GRAPHQL_URL, {
        operationName: 'MintActionTimelineQuery',
        query: MINT_QUERY,
        variables
      })

      const data = response.data

      if (data.errors && data.errors.length > 0) {
        const errorMessages = data.errors.map((e: { message: string }) => e.message).join('; ')
        throw new Error(`GraphQL errors: ${errorMessages}`)
      }

      const actions = data.data?.swap?.actions
      if (!actions || actions.length === 0) {
        throw new Error('No actions returned from OpenSea - возможно, кошелек не eligible или требуется аутентификация')
      }

      let actionWithTxData: { transactionSubmissionData: TransactionSubmissionData } | null = null

      for (const action of actions) {
        const actionTyped = action as { __typename: string, [key: string]: unknown }
        const txData = actionTyped['transactionSubmissionData']
        if (txData && typeof txData === 'object') {
          actionWithTxData = { transactionSubmissionData: txData as unknown as TransactionSubmissionData }
          break
        }
      }

      if (!actionWithTxData) {
        const mintAction = actions.find((action: { __typename: string }) => action.__typename === 'MintAction')
        if (mintAction) {
          const mintActionTyped = mintAction as { [key: string]: unknown }
          const txData = mintActionTyped['transactionSubmissionData']
          if (txData && typeof txData === 'object') {
            actionWithTxData = { transactionSubmissionData: txData as unknown as TransactionSubmissionData }
          }
        }
      }

      if (!actionWithTxData || !actionWithTxData.transactionSubmissionData) {
        const actionTypes = actions.map((a: { __typename: string }) => a.__typename).join(', ')
        logger.warn(`Найдены actions: ${actionTypes}, но нет action с transactionSubmissionData`)
        logger.warn('Возможно, минт еще не доступен для этого кошелька или требуется дополнительная аутентификация')
        throw new Error('MintAction not found or missing transaction data')
      }

      logger.success('Данные транзакции получены из OpenSea')
      return actionWithTxData.transactionSubmissionData as TransactionSubmissionData
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      logger.warn(`Попытка ${attempt}/${OPENSEA_CONFIG.retryAttempts} получения данных из OpenSea неудачна: ${lastError}`)

      if (attempt < OPENSEA_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  throw new Error(`Все ${OPENSEA_CONFIG.retryAttempts} попыток получения данных из OpenSea неудачны. Последняя ошибка: ${lastError}`)
}

/**
 * Создает axios instance для OpenSea запросов с прокси
 */
function createOpenSeaAxiosInstance (proxy: import('../proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
  const proxyManager = ProxyManager.getInstance()
  const proxyAgents = proxyManager.createProxyAgents(proxy)
  const userAgent = getRandomUserAgent()

  return axios.create({
    timeout: OPENSEA_CONFIG.timeout,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-app-id': 'os2-web',
      'User-Agent': userAgent,
      Origin: 'https://opensea.io',
      Referer: 'https://opensea.io/'
    },
    httpsAgent: proxyAgents.httpsAgent,
    httpAgent: proxyAgents.httpAgent
  })
}

/**
 * Выполняет минт NFT
 */
async function performMint (privateKey: `0x${string}`, txData: TransactionSubmissionData): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const publicClient = rpcManager.createPublicClient(soneiumChain)

    logger.info('Отправка транзакции минта...')
    logger.info(`To: ${txData.to}, Value: ${txData.value}, Data length: ${txData.data.length} bytes`)

    const hash = await walletClient.sendTransaction({
      to: txData.to as `0x${string}`,
      data: txData.data as `0x${string}`,
      value: BigInt(txData.value || '0'),
      account: account,
      chain: walletClient.chain
    })

    logger.transaction(hash, 'sent', 'SEASON6_BADGE_MINT', account.address)

    logger.info('Ожидание подтверждения транзакции...')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.success(`Транзакция подтверждена в блоке ${receipt.blockNumber}`)
      logger.transaction(hash, 'confirmed', 'SEASON6_BADGE_MINT', account.address)
    } else {
      logger.error('Транзакция не подтверждена')
      logger.transaction(hash, 'failed', 'SEASON6_BADGE_MINT', account.address)
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выполнении минта', error)
    throw error
  }
}

/**
 * Главная функция модуля - проверка и минт бейджа за 6 сезон
 */
export async function performSeason6BadgeMint (
  privateKey: `0x${string}`
): Promise<{
  success: boolean
  walletAddress?: string
  season6Points?: number
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletAddress = account.address

    logger.info(`Season 6 Badge Mint: начало проверки кошелька ${walletAddress}`)

    const nftBalance = await checkSeason6NFTBalance(walletAddress)
    if (nftBalance > 0n) {
      logger.success(`NFT уже есть у кошелька (баланс: ${nftBalance.toString()}), пропускаем`)
      const season6Data = await getSeason6Points(walletAddress)
      const result: {
        success: boolean
        walletAddress: string
        season6Points?: number
        skipped: boolean
        reason: string
      } = {
        success: true,
        walletAddress,
        skipped: true,
        reason: `NFT уже есть у кошелька (баланс: ${nftBalance.toString()})`
      }
      if (season6Data?.totalScore !== undefined) {
        result.season6Points = season6Data.totalScore
      }
      return result
    }

    logger.info('Получение данных сезона 6 через API...')
    const season6Data = await getSeason6Points(walletAddress)

    if (!season6Data) {
      const error = 'Нет данных за сезон 6'
      logger.error(error)
      return {
        success: false,
        walletAddress,
        error
      }
    }

    const eligibility = checkMintEligibility(season6Data.totalScore)
    logger.info(`Eligibility проверка: ${eligibility.reason}`)

    if (!eligibility.eligible) {
      return {
        success: true,
        walletAddress,
        season6Points: season6Data.totalScore,
        skipped: true,
        reason: eligibility.reason
      }
    }

    logger.info('Получение данных транзакции минта из OpenSea...')
    const txData = await getMintTransactionFromOpenSea(walletAddress)

    const txHash = await performMint(privateKey, txData)

    const explorerUrl = `https://soneium.blockscout.com/tx/${txHash}`

    logger.success(`Минт выполнен успешно! TX: ${explorerUrl}`)

    return {
      success: true,
      walletAddress,
      season6Points: season6Data.totalScore,
      transactionHash: txHash,
      explorerUrl
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error(`Ошибка при выполнении Season 6 Badge Mint: ${errorMessage}`, error)

    let season6Points: number | undefined
    try {
      const account = privateKeyToAccount(privateKey)
      const season6Data = await getSeason6Points(account.address)
      season6Points = season6Data?.totalScore
    } catch {
      // Игнорируем ошибку получения поинтов
    }

    const result: {
      success: boolean
      walletAddress: string
      season6Points?: number
      error: string
    } = {
      success: false,
      walletAddress: privateKeyToAccount(privateKey).address,
      error: errorMessage
    }
    if (season6Points !== undefined) {
      result.season6Points = season6Points
    }
    return result
  }
}
