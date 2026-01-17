import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адрес контракта NFT (ERC-721)
const NFT_CONTRACT_ADDRESS = '0x43048f15167bdb4a592c2f0f92b9a39e51240f39' as `0x${string}`

// Конфигурация IPFS
const IPFS_BASE_URL = 'https://gateway.pinata.cloud/ipfs/'
const IPFS_HASH_PREFIX = 'Qm'
const IPFS_HASH_LENGTH = 44 // Символов после Qm

// ABI контракта (только нужные функции)
const NFT_CONTRACT_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'string', name: 'uri', type: 'string' }
    ],
    name: 'safeMint',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Проверяет баланс NFT у кошелька
 */
async function checkNFTBalance (address: `0x${string}`): Promise<bigint> {
  try {
    const balance = await publicClient.readContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: NFT_CONTRACT_ABI,
      functionName: 'balanceOf',
      args: [address]
    })

    return balance as bigint
  } catch (error) {
    logger.error('Ошибка при проверке баланса NFT', error)
    throw error
  }
}

/**
 * Генерирует случайный IPFS URI
 */
function generateRandomIPFSUri (): string {
  // Символы для генерации IPFS hash (Base58-подобный набор)
  const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let hash = IPFS_HASH_PREFIX

  // Генерируем 44 случайных символа
  for (let i = 0; i < IPFS_HASH_LENGTH; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length)
    hash += characters[randomIndex]
  }

  return `${IPFS_BASE_URL}${hash}`
}

/**
 * Выполняет минт NFT
 */
async function performMint (privateKey: `0x${string}`, toAddress: `0x${string}`, uri: string): Promise<`0x${string}`> {
  const account = privateKeyToAccount(privateKey)
  const walletClient = rpcManager.createWalletClient(soneiumChain, account)

  logger.info(`Выполняем минт NFT для адреса ${toAddress}`)
  logger.info(`IPFS URI: ${uri}`)

  const txResult = await safeWriteContract(
    publicClient,
    walletClient,
    account.address,
    {
      chain: soneiumChain,
      account: account,
      address: NFT_CONTRACT_ADDRESS,
      abi: NFT_CONTRACT_ABI,
      functionName: 'safeMint',
      args: [toAddress, uri]
    }
  )

  if (!txResult.success) {
    throw new Error(txResult.error || 'Ошибка отправки транзакции')
  }

  return txResult.hash
}

/**
 * Выполняет NFT Pods модуль
 */
export async function performNFTPods (
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
    logger.info(`NFT Pods: проверка баланса NFT для кошелька ${account.address}`)

    // Проверяем баланс NFT
    const balance = await checkNFTBalance(account.address)
    logger.info(`Баланс NFT: ${balance.toString()}`)

    // Если NFT уже есть, пропускаем кошелек
    if (balance > 0n) {
      logger.success('NFT уже есть у кошелька, пропускаем')
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: `NFT уже есть (баланс: ${balance.toString()})`
      }
    }

    // Если NFT нет, выполняем минт
    logger.info('NFT не найдено, выполняем минт...')

    // Генерируем случайный IPFS URI
    const randomUri = generateRandomIPFSUri()
    logger.info(`Сгенерирован случайный IPFS URI: ${randomUri}`)

    // Выполняем минт
    const hash = await performMint(privateKey, account.address, randomUri)
    logger.transaction(hash, 'sent', 'NFT_PODS')

    // Ждем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'NFT_PODS', account.address)
      logger.success(`Транзакция подтверждена: https://soneium.blockscout.com/tx/${hash}`)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: hash,
        message: 'NFT успешно заминчено'
      }
    } else {
      logger.transaction(hash, 'failed', 'NFT_PODS', account.address)
      return {
        success: false,
        walletAddress: account.address,
        transactionHash: hash,
        error: 'Transaction reverted'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении NFT Pods', error)
    return {
      success: false,
      walletAddress: privateKeyToAccount(privateKey).address,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
