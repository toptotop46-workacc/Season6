import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import axios from 'axios'

// Адрес контракта SurfBox (из блокчейн-эксплорера)
const CONTRACT_ADDRESS = '0x4a6a5af20650a6fcfe799ad50887e89493c5773d' as `0x${string}`

// ABI контракта SurfBox
const CONTRACT_ABI = [
  {
    inputs: [],
    name: 'gasFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'lootBox',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  }
] as const

// Конфигурация
const API_BASE_URL = 'https://portal.soneium.org/api'
const SURFLAYER_QUEST_ID = 'surflayer_6'

const proxyManager = ProxyManager.getInstance()
const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Проверяет статус квеста Surflayer
 */
async function checkSurflayerQuestStatus (address: string): Promise<{ isCompleted: boolean; progress: string } | null> {
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

    const surflayerQuest = bonusData
      .filter((item: { season: number; id: string }) => item.season === 6)
      .find((item: { id: string }) => item.id === SURFLAYER_QUEST_ID)

    if (!surflayerQuest) return null

    const totalCompleted = surflayerQuest.quests.reduce((sum: number, q: { completed: number }) => sum + q.completed, 0)
    const totalRequired = surflayerQuest.quests.reduce((sum: number, q: { required: number }) => sum + q.required, 0)

    return {
      isCompleted: totalCompleted >= totalRequired,
      progress: `${totalCompleted}/${totalRequired}`
    }
  } catch {
    return null
  }
}

/**
 * Получает gasFee из контракта
 */
async function getGasFee (): Promise<bigint> {
  try {
    const gasFee = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'gasFee'
    })

    return gasFee as bigint
  } catch (error) {
    logger.error('Ошибка при получении gasFee из контракта', error)
    throw error
  }
}

/**
 * Выполняет транзакцию lootBox
 */
async function performLootBox (privateKey: `0x${string}`, gasFee: bigint): Promise<`0x${string}`> {
  const account = privateKeyToAccount(privateKey)
  const walletClient = rpcManager.createWalletClient(soneiumChain, account)

  logger.info(`Выполняем транзакцию lootBox с gasFee: ${formatEther(gasFee)} ETH`)

  const txResult = await safeWriteContract(
    publicClient,
    walletClient,
    account.address,
    {
      chain: soneiumChain,
      account: account,
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'lootBox',
      args: [],
      value: gasFee
    }
  )

  if (!txResult.success) {
    throw new Error(txResult.error || 'Ошибка отправки транзакции')
  }

  return txResult.hash
}

/**
 * Выполняет Bonus Surflayer модуль
 */
export async function performBonusSurflayer (
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
    logger.info(`Bonus Surflayer: проверка статуса квеста для кошелька ${account.address}`)

    // Проверяем статус квеста
    const questStatus = await checkSurflayerQuestStatus(account.address)

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

    logger.info(`Статус квеста Surflayer: ${questStatus.progress}`)

    // Если квест выполнен, пропускаем аккаунт
    if (questStatus.isCompleted) {
      logger.success('Квест Surflayer уже выполнен, транзакция не требуется')
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: `Квест выполнен (${questStatus.progress})`
      }
    }

    // Выполняем транзакцию только если квест не выполнен
    logger.info('Квест не выполнен, выполняем транзакцию lootBox...')

    // Получаем gasFee из контракта
    const gasFee = await getGasFee()
    logger.info(`Требуемая комиссия: ${formatEther(gasFee)} ETH`)

    // Проверяем баланс ETH
    const balance = await publicClient.getBalance({ address: account.address })
    const estimatedGas = 100000n // Примерная оценка газа для транзакции
    const estimatedGasCost = estimatedGas * 1000000000n // Предполагаем цену газа ~1 gwei
    const requiredBalance = gasFee + estimatedGasCost

    if (balance < requiredBalance) {
      logger.warn(`Недостаточный баланс. Требуется: ${formatEther(requiredBalance)} ETH, доступно: ${formatEther(balance)} ETH`)
      return {
        success: false,
        walletAddress: account.address,
        error: `Недостаточный баланс. Требуется: ${formatEther(requiredBalance)} ETH`
      }
    }

    // Выполняем транзакцию lootBox
    const hash = await performLootBox(privateKey, gasFee)
    logger.transaction(hash, 'sent', 'BONUS_SURFLAYER')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'BONUS_SURFLAYER', account.address)
      logger.success(`Транзакция подтверждена: https://soneium.blockscout.com/tx/${hash}`)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: hash,
        message: 'Транзакция успешно выполнена'
      }
    } else {
      logger.transaction(hash, 'failed', 'BONUS_SURFLAYER', account.address)
      return {
        success: false,
        walletAddress: account.address,
        transactionHash: hash,
        error: 'Transaction reverted'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении Bonus Surflayer', error)
    return {
      success: false,
      walletAddress: privateKeyToAccount(privateKey).address,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
