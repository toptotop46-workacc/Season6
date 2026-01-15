import { formatUnits, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ensureUSDCBalance } from '../usdc-balance-manager.js'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { logger } from '../logger.js'

// Адреса контрактов Sake Finance (Aave протокол)
const L2_POOL_INSTANCE = '0x3c3987a310ee13f7b8cbbe21d97d4436ba5e4b5f' // L2PoolInstance контракт
const A_TOKEN_INSTANCE = '0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726' // ATokenInstance контракт
const USDC_E_TOKEN = '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369' // USDC.e токен

// ABI для ERC20 токена (USDC.e)
const ERC20_ABI = [
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' },
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' }
    ],
    'name': 'allowance',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' }
    ],
    'name': 'approve',
    'outputs': [{ 'internalType': 'bool', 'name': '', 'type': 'bool' }],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [{ 'internalType': 'address', 'name': 'account', 'type': 'address' }],
    'name': 'balanceOf',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'decimals',
    'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'symbol',
    'outputs': [{ 'internalType': 'string', 'name': '', 'type': 'string' }],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// ABI для L2PoolInstance контракта
const L2_POOL_ABI = [
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'asset', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'onBehalfOf', 'type': 'address' },
      { 'internalType': 'uint16', 'name': 'referralCode', 'type': 'uint16' }
    ],
    'name': 'supply',
    'outputs': [],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'asset', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'to', 'type': 'address' }
    ],
    'name': 'withdraw',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'user', 'type': 'address' }
    ],
    'name': 'getUserAccountData',
    'outputs': [
      { 'internalType': 'uint256', 'name': 'totalCollateralETH', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'totalDebtETH', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'availableBorrowsETH', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'currentLiquidationThreshold', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'ltv', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'healthFactor', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// ABI для ATokenInstance контракта
const A_TOKEN_ABI = [
  {
    'inputs': [{ 'internalType': 'address', 'name': 'account', 'type': 'address' }],
    'name': 'balanceOf',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'decimals',
    'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'totalSupply',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'user', 'type': 'address' }
    ],
    'name': 'scaledBalanceOf',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// Создание публичного клиента
const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Получает баланс USDC.e токена для указанного адреса
 */
export async function getUSDCBalance (address: `0x${string}`): Promise<string> {
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
    logger.error('Ошибка при получении баланса USDC.e', error)
    throw error
  }
}

/**
 * Получает баланс aToken для указанного адреса
 */
export async function getATokenBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'balanceOf',
      args: [address]
    })

    const decimals = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'decimals'
    })

    return formatUnits(balance, decimals)
  } catch (error) {
    logger.error('Ошибка при получении баланса aToken', error)
    throw error
  }
}

/**
 * Проверяет allowance (разрешение) для L2PoolInstance контракта
 */
export async function checkAllowance (owner: `0x${string}`, amount: string): Promise<boolean> {
  try {
    const allowance = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, L2_POOL_INSTANCE]
    })

    // Проверяем, есть ли безлимитный approve (максимальное значение uint256)
    const maxAmount = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
    const hasUnlimitedAllowance = allowance >= maxAmount

    if (hasUnlimitedAllowance) {
      logger.info('Безлимитный approve уже установлен')
      return true
    }

    // Если нет безлимитного, проверяем обычный allowance
    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(amount, decimals)
    const hasEnoughAllowance = allowance >= amountWei

    logger.info(`Требуется: ${amount} USDC.e`)
    logger.info(`Достаточно allowance: ${hasEnoughAllowance}`)

    return hasEnoughAllowance
  } catch (error) {
    logger.error('Ошибка при проверке allowance', error)
    throw error
  }
}

/**
 * Выполняет approve для L2PoolInstance контракта на указанную сумму
 */
export async function approveUSDC (privateKey: `0x${string}`, amount: string): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Получаем decimals токена
    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    // Конвертируем сумму в wei
    const amountWei = parseUnits(amount, decimals)

    logger.operation('Approve для Sake Finance', 'start')

    // Получаем рекомендуемый лимит газа и увеличиваем на 50%
    const estimatedGas = await publicClient.estimateContractGas({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [L2_POOL_INSTANCE, amountWei],
      account: account
    })

    const gasLimit = BigInt(Math.floor(Number(estimatedGas) * 1.5))

    const hash = await walletClient.writeContract({
      chain: soneiumChain,
      account: account,
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [L2_POOL_INSTANCE, amountWei],
      gas: gasLimit
    })

    logger.transaction(hash, 'sent', 'SAKE_FINANCE')

    // Ожидаем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.operation('Approve для Sake Finance', 'success')
      logger.transaction(hash, 'confirmed', 'SAKE_FINANCE', account.address)
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.operation('Approve для Sake Finance', 'error')
      throw new Error('Approve transaction failed')
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выполнении approve', error)
    throw error
  }
}

/**
 * Добавляет ликвидность в Sake Finance пул (supply)
 */
export async function addLiquidity (privateKey: `0x${string}`, amount: string): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(amount, decimals)

    // Добавляем ликвидность

    // Добавляем ликвидность с увеличенным лимитом газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>

    try {
      hash = await walletClient.writeContract({
        chain: soneiumChain,
        account: account,
        address: L2_POOL_INSTANCE,
        abi: L2_POOL_ABI,
        functionName: 'supply',
        args: [USDC_E_TOKEN, amountWei, account.address, 0], // asset, amount, onBehalfOf, referralCode
        gas: 500000n // Увеличенный лимит газа для сложной операции Sake Finance
      })

      // Ожидаем подтверждения
      receipt = await publicClient.waitForTransactionReceipt({ hash })
    } catch (error) {
      // Если ошибка связана с газом, пробуем с еще большим лимитом
      if (error instanceof Error && error.message.includes('gas')) {
        logger.warn('Ошибка газа, пробуем с увеличенным лимитом...')

        hash = await walletClient.writeContract({
          chain: soneiumChain,
          account: account,
          address: L2_POOL_INSTANCE,
          abi: L2_POOL_ABI,
          functionName: 'supply',
          args: [USDC_E_TOKEN, amountWei, account.address, 0],
          gas: 800000n // Еще больший лимит газа
        })

        receipt = await publicClient.waitForTransactionReceipt({ hash })
      } else {
        throw error
      }
    }

    if (receipt.status === 'success') {
      await new Promise(resolve => setTimeout(resolve, 30000))
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при добавлении ликвидности', error)
    throw error
  }
}

/**
 * Выводит ликвидность (withdraw) из Sake Finance пула
 */
export async function redeemLiquidity (privateKey: `0x${string}`, amount: string | null = null): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Получаем текущий баланс aToken
    const aTokenBalance = await getATokenBalance(account.address)

    if (parseFloat(aTokenBalance) === 0) {
      throw new Error('Нет aToken для вывода')
    }

    // Определяем количество для вывода
    const withdrawAmount = amount || aTokenBalance
    if (parseFloat(withdrawAmount) > parseFloat(aTokenBalance)) {
      throw new Error('Недостаточно aToken для указанной суммы')
    }

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(withdrawAmount, decimals)

    logger.operation(`Вывод ${withdrawAmount} USDC.e из Sake Finance`, 'start')

    // Выводим ликвидность с увеличенным лимитом газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>

    try {
      hash = await walletClient.writeContract({
        chain: soneiumChain,
        account: account,
        address: L2_POOL_INSTANCE,
        abi: L2_POOL_ABI,
        functionName: 'withdraw',
        args: [USDC_E_TOKEN, amountWei, account.address], // asset, amount, to
        gas: 500000n // Увеличенный лимит газа для сложной операции Sake Finance
      })

      logger.transaction(hash, 'sent', 'SAKE_FINANCE')

      // Ожидаем подтверждения
      receipt = await publicClient.waitForTransactionReceipt({ hash })
    } catch (error) {
      // Если ошибка связана с газом, пробуем с еще большим лимитом
      if (error instanceof Error && error.message.includes('gas')) {
        logger.warn('Ошибка газа, пробуем с увеличенным лимитом...')

        hash = await walletClient.writeContract({
          chain: soneiumChain,
          account: account,
          address: L2_POOL_INSTANCE,
          abi: L2_POOL_ABI,
          functionName: 'withdraw',
          args: [USDC_E_TOKEN, amountWei, account.address],
          gas: 800000n // Еще больший лимит газа
        })

        receipt = await publicClient.waitForTransactionReceipt({ hash })
      } else {
        throw error
      }
    }

    if (receipt.status === 'success') {
      logger.operation(`Вывод ${withdrawAmount} USDC.e из Sake Finance`, 'success')
      logger.transaction(hash, 'confirmed', 'SAKE_FINANCE', account.address)
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.operation(`Вывод ${withdrawAmount} USDC.e из Sake Finance`, 'error')
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выводе ликвидности', error)
    throw error
  }
}

/**
 * Получает информацию о балансе ETH
 */
export async function getETHBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.getBalance({ address })
    return formatUnits(balance, 18)
  } catch (error) {
    logger.error('Ошибка при получении баланса ETH', error)
    throw error
  }
}

/**
 * Получает общий supply aToken
 */
export async function getATokenTotalSupply (): Promise<string> {
  try {
    const totalSupply = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'totalSupply'
    })

    const decimals = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'decimals'
    })

    return formatUnits(totalSupply, decimals)
  } catch (error) {
    logger.error('Ошибка при получении общего supply aToken', error)
    throw error
  }
}

/**
 * Получает данные аккаунта пользователя в Sake Finance
 */
export async function getUserAccountData (address: `0x${string}`): Promise<{
  totalCollateralETH: string
  totalDebtETH: string
  availableBorrowsETH: string
  currentLiquidationThreshold: string
  ltv: string
  healthFactor: string
}> {
  try {
    const accountData = await publicClient.readContract({
      address: L2_POOL_INSTANCE,
      abi: L2_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [address]
    })

    return {
      totalCollateralETH: formatUnits(accountData[0], 18),
      totalDebtETH: formatUnits(accountData[1], 18),
      availableBorrowsETH: formatUnits(accountData[2], 18),
      currentLiquidationThreshold: formatUnits(accountData[3], 4),
      ltv: formatUnits(accountData[4], 4),
      healthFactor: formatUnits(accountData[5], 18)
    }
  } catch (error) {
    logger.error('Ошибка при получении данных аккаунта', error)
    // Возвращаем пустые данные вместо выброса ошибки
    return {
      totalCollateralETH: '0',
      totalDebtETH: '0',
      availableBorrowsETH: '0',
      currentLiquidationThreshold: '0',
      ltv: '0',
      healthFactor: '0'
    }
  }
}

/**
 * Выводит детальную информацию о ликвидности
 */
export async function displayLiquidityInfo (userAddress: `0x${string}`, operation: string, amount: string): Promise<void> {
  try {
    logger.success(`${operation} выполнен успешно!`)
    logger.balance('USDC.e', `${amount} USDC.e`, userAddress)

    // Получаем только балансы кошелька
    const usdcBalance = await getUSDCBalance(userAddress)
    const ethBalance = await getETHBalance(userAddress)

    logger.balance('USDC.e', `${usdcBalance} USDC.e`, userAddress)
    logger.balance('ETH', `${ethBalance} ETH`, userAddress)

  } catch (error) {
    logger.error('Ошибка при выводе информации о ликвидности', error)
  }
}

/**
 * Основная функция модуля Sake Finance с логикой:
 * Если есть токены ликвидности → вывод
 * Если нет токенов ликвидности → депозит
 */
export async function performSakeFinanceOperations (privateKey: `0x${string}`, amount: string | null = null): Promise<{
  success: boolean
  walletAddress?: string
  usdcBalance?: string
  aTokenBalance?: string
  depositAmount?: string
  supplyTransactionHash?: string
  withdrawTransactionHash?: string | null
  explorerUrl?: string
  usdcPurchased?: boolean
  usdcPurchaseHash?: string | undefined
  usdcPurchaseAmount?: string | undefined
  error?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)

    // 1. Проверяем текущую ликвидность (aToken баланс)
    logger.info('Проверяем текущую ликвидность в Sake Finance...')
    const aTokenBalance = await getATokenBalance(account.address)

    // 2. Если есть токены ликвидности, выводим их
    if (parseFloat(aTokenBalance) > 0) {
      logger.info('Обнаружена существующая ликвидность, выводим...')
      const withdrawTxHash = await redeemLiquidity(privateKey)

      // Выводим информацию после вывода
      await displayLiquidityInfo(account.address, 'withdraw', aTokenBalance)

      return {
        success: true,
        walletAddress: account.address,
        aTokenBalance: aTokenBalance,
        withdrawTransactionHash: withdrawTxHash,
        explorerUrl: `https://soneium.blockscout.com/tx/${withdrawTxHash}`
      }
    } else {
      logger.info('Существующая ликвидность не найдена, делаем депозит...')

      // 3. Проверяем и обеспечиваем наличие USDC.e для депозита
      const usdcBalanceResult = await ensureUSDCBalance(privateKey, '0.0001')

      if (!usdcBalanceResult.success) {
        throw new Error(`Не удалось обеспечить наличие USDC.e: ${usdcBalanceResult.error}`)
      }

      const usdcBalance = usdcBalanceResult.usdcBalance

      if (usdcBalanceResult.purchased) {
        logger.success('USDC.e автоматически куплен через jumper')
        logger.transaction(usdcBalanceResult.purchaseHash!, 'confirmed', 'SAKE_FINANCE')
      }

      // 4. Определяем количество для депозита
      const depositAmount = amount || usdcBalance
      if (parseFloat(depositAmount) > parseFloat(usdcBalance)) {
        throw new Error('Недостаточно USDC.e на балансе для указанной суммы')
      }

      logger.info(`Количество для депозита: ${depositAmount} USDC.e`)

      // 5. Проверяем allowance
      const hasAllowance = await checkAllowance(account.address, depositAmount)

      // 6. Если нужно, выполняем approve
      if (!hasAllowance) {
        logger.info('Недостаточно allowance, выполняем approve...')
        await approveUSDC(privateKey, depositAmount)
      } else {
        logger.info('Allowance достаточен')
      }

      // 7. Добавляем ликвидность
      logger.operation(`Депозит ${depositAmount} USDC.e в Sake Finance`, 'start')
      const supplyTxHash = await addLiquidity(privateKey, depositAmount)

      // 8. Выводим детальную информацию после депозита
      await displayLiquidityInfo(account.address, 'supply', depositAmount)

      return {
        success: true,
        walletAddress: account.address,
        usdcBalance: usdcBalance,
        aTokenBalance: aTokenBalance,
        depositAmount: depositAmount,
        supplyTransactionHash: supplyTxHash,
        explorerUrl: `https://soneium.blockscout.com/tx/${supplyTxHash}`,
        usdcPurchased: usdcBalanceResult.purchased || false,
        usdcPurchaseHash: usdcBalanceResult.purchaseHash || undefined,
        usdcPurchaseAmount: usdcBalanceResult.purchaseAmount || undefined
      }
    }

  } catch (error) {
    logger.error('Ошибка при выполнении операций Sake Finance', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

// Экспорт констант для использования в других модулях
export {
  L2_POOL_INSTANCE,
  A_TOKEN_INSTANCE,
  USDC_E_TOKEN,
  ERC20_ABI,
  L2_POOL_ABI,
  A_TOKEN_ABI
}
