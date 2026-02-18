import { formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { performJumperSwap } from './modules/jumper.js'
import { rpcManager, soneiumChain } from './rpc-manager.js'

// Адрес USDC.e токена в сети Soneium
const USDC_E_TOKEN = '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369' as const

// ABI для ERC20 токенов (только необходимые методы)
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }]
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }]
  }
] as const

// Создаем публичный клиент для чтения данных с fallback RPC
const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Получает баланс USDC.e токена для указанного адреса
 */
async function getUSDCBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address]
    })

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    return formatUnits(balance, decimals)
  } catch (error) {
    console.error('Ошибка при получении баланса USDC.e:', error)
    throw error
  }
}

/**
 * Получает баланс ETH для указанного адреса
 */
async function getETHBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.getBalance({
      address: address
    })
    return formatUnits(balance, 18)
  } catch (error) {
    console.error('Ошибка при получении баланса ETH:', error)
    throw error
  }
}

/**
 * Интерфейс для результата проверки и покупки USDC.e
 */
export interface USDCBalanceResult {
  success: boolean
  usdcBalance: string
  purchased?: boolean
  purchaseHash?: string
  purchaseAmount?: string
  error?: string
}

/**
 * Обеспечивает наличие USDC.e на кошельке
 * Если баланс USDC.e меньше minAmount, автоматически покупает USDC.e через jumper
 */
export async function ensureUSDCBalance (
  privateKey: `0x${string}`,
  minAmount: string = '0'
): Promise<USDCBalanceResult> {
  try {
    // Получаем адрес кошелька
    const account = privateKeyToAccount(privateKey)
    const walletAddress = account.address

    console.log(`🔍 Проверяем баланс USDC.e для кошелька: ${walletAddress}`)

    // Проверяем текущий баланс USDC.e
    const currentUSDCBalance = await getUSDCBalance(walletAddress)
    console.log(`💰 Текущий баланс USDC.e: ${currentUSDCBalance}`)

    // Если баланс достаточный, возвращаем успех
    if (parseFloat(currentUSDCBalance) >= parseFloat(minAmount)) {
      console.log(`✅ Баланс USDC.e достаточен (${currentUSDCBalance} >= ${minAmount})`)
      return {
        success: true,
        usdcBalance: currentUSDCBalance,
        purchased: false
      }
    }

    console.log(`⚠️ Недостаточно USDC.e (${currentUSDCBalance} < ${minAmount}), покупаем через jumper...`)

    // Проверяем баланс ETH перед покупкой
    const ethBalance = await getETHBalance(walletAddress)
    console.log(`💎 Баланс ETH: ${ethBalance}`)

    if (parseFloat(ethBalance) === 0) {
      const error = 'Недостаточно ETH для покупки USDC.e'
      console.error(`❌ ${error}`)
      return {
        success: false,
        usdcBalance: currentUSDCBalance,
        error: error
      }
    }

    // Покупаем USDC.e через jumper
    console.log('🔄 Запускаем jumper для покупки USDC.e...')
    const jumperResult = await performJumperSwap(privateKey)

    if (!jumperResult.success) {
      const error = `Не удалось купить USDC.e через jumper: ${jumperResult.error}`
      console.error(`❌ ${error}`)
      return {
        success: false,
        usdcBalance: currentUSDCBalance,
        error: error
      }
    }

    console.log('✅ USDC.e успешно куплен через jumper!')
    console.log('⏳ Ожидаем поступления USDC.e на баланс (30 секунд)...')
    await new Promise(resolve => setTimeout(resolve, 30000))

    // Проверяем новый баланс USDC.e
    const newUSDCBalance = await getUSDCBalance(walletAddress)
    console.log(`💰 Новый баланс USDC.e: ${newUSDCBalance}`)

    return {
      success: true,
      usdcBalance: newUSDCBalance,
      purchased: true,
      purchaseHash: jumperResult.transactionHash || '',
      purchaseAmount: jumperResult.swapAmount || ''
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    console.error('❌ Ошибка в ensureUSDCBalance:', errorMessage)
    return {
      success: false,
      usdcBalance: '0',
      error: errorMessage
    }
  }
}

