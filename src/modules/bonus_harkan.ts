import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import axios from 'axios'

// Адрес контракта GameHubUpgradeable
const CONTRACT_ADDRESS = '0x983B499181A1B376CEE9Ffe18984cF62A767f745' as `0x${string}`

// ABI контракта
const CONTRACT_ABI = [
  {
    inputs: [
      { internalType: 'string', name: 'gameId', type: 'string' },
      { internalType: 'string', name: 'action', type: 'string' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
      { internalType: 'uint256', name: 'randomNums', type: 'uint256' },
      { internalType: 'uint256', name: 'maxInt', type: 'uint256' }
    ],
    name: 'recordActionWithRandom',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

// Фиксированные параметры транзакции
const GAME_ID = 'cyber-roulette'
const ACTION = 'spin'
const VALUE = BigInt(0)
const RANDOM_NUMS = BigInt(1)
const MAX_INT = BigInt(1000)

const API_BASE_URL = 'https://portal.soneium.org/api'
const proxyManager = ProxyManager.getInstance()
const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Проверяет статус квеста Harkan
 */
async function checkHarkanQuestStatus (address: string): Promise<{ isCompleted: boolean; progress: string } | null> {
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

    const harkanQuest = bonusData
      .filter((item: { season: number; id: string }) => item.season === 6)
      .find((item: { id: string }) => item.id === 'harkan_6')

    if (!harkanQuest) return null

    const totalCompleted = harkanQuest.quests.reduce((sum: number, q: { completed: number }) => sum + q.completed, 0)
    const totalRequired = harkanQuest.quests.reduce((sum: number, q: { required: number }) => sum + q.required, 0)

    return {
      isCompleted: totalCompleted >= totalRequired,
      progress: `${totalCompleted}/${totalRequired}`
    }
  } catch {
    return null
  }
}

/**
 * Выполняет Bonus Harkan модуль
 */
export async function performBonusHarkan (
  privateKey: `0x${string}`
): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.info(`Bonus Harkan: проверка статуса квеста для кошелька ${account.address}`)

    // Проверяем статус квеста
    const questStatus = await checkHarkanQuestStatus(account.address)

    // Если не удалось получить данные, пропускаем аккаунт
    if (!questStatus) {
      logger.warn('Не удалось получить данные о статусе квеста, аккаунт пропускается')
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: 'Не удалось получить данные о статусе квеста'
      }
    }

    logger.info(`Статус квеста Harkan: ${questStatus.progress}`)

    // Если квест выполнен, пропускаем аккаунт
    if (questStatus.isCompleted) {
      logger.success('Квест Harkan уже выполнен, транзакция не требуется')
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: `Квест выполнен (${questStatus.progress})`
      }
    }

    // Выполняем транзакцию только если квест не выполнен
    logger.info('Квест не выполнен, выполняем транзакцию...')
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account: account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'recordActionWithRandom',
        args: [GAME_ID, ACTION, VALUE, RANDOM_NUMS, MAX_INT]
      }
    )

    if (!txResult.success) {
      return {
        success: false,
        walletAddress: account.address,
        error: txResult.error || 'Ошибка отправки транзакции'
      }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'BONUS_HARKAN')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'BONUS_HARKAN', account.address)
      logger.success(`Транзакция подтверждена: https://soneium.blockscout.com/tx/${hash}`)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: hash,
        message: 'Транзакция успешно выполнена'
      }
    } else {
      logger.transaction(hash, 'failed', 'BONUS_HARKAN', account.address)
      return {
        success: false,
        walletAddress: account.address,
        transactionHash: hash,
        error: 'Transaction reverted'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении Bonus Harkan', error)
    throw error
  }
}
