import { formatUnits, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SoneiumSwap } from './jumper.js'
import { redeemLiquidity } from './sake-finance.js'
import { redeemLiquidity as redeemAaveLiquidity } from './aave.js'
import { withdraw as withdrawFromUntitledBank } from './untitled-bank.js'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { logger } from '../logger.js'

// Адреса токенов
const TOKENS = {
  ETH: '0x0000000000000000000000000000000000000000',
  USDT: '0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35',
  USDC_e: '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369'
} as const

// Адреса контрактов протоколов
const PROTOCOL_CONTRACTS = {
  // Aave
  AAVE_L2_POOL: '0xdd3d7a7d03d9fd9ef45f3e587287922ef65ca38b',
  AAVE_A_TOKEN: '0xb2C9E934A55B58D20496A5019F8722a96d8A44d8',

  // Morpho
  MORPHO_METAMORPHO: '0xecdbe2af33e68cf96f6716f706b078fa94e978cb',

  // Stargate
  STARGATE_POOL: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
  STARGATE_LP_TOKEN: '0x5b091dc6f94b5e2b54edab3800759abf0ed7d26d',

  // Sake Finance
  SAKE_ATOKEN: '0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726',

  // Untitled Bank
  UNTITLED_BANK: '0xc675BB95D73CA7db2C09c3dC04dAaA7944CCBA41'
} as const

// ABI для ERC20 токенов
const ERC20_ABI = [
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
    'inputs': [
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' },
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' }
    ],
    'name': 'allowance',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// ABI для Morpho MetaMorpho
const MORPHO_ABI = [
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': 'shares', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'receiver', 'type': 'address' },
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' }
    ],
    'name': 'redeem',
    'outputs': [{ 'internalType': 'uint256', 'name': 'assets', 'type': 'uint256' }],
    'stateMutability': 'nonpayable',
    'type': 'function'
  }
] as const

// ABI для Stargate
const STARGATE_ABI = [
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': '_amountLD', 'type': 'uint256' },
      { 'internalType': 'address', 'name': '_receiver', 'type': 'address' }
    ],
    'name': 'redeem',
    'outputs': [{ 'internalType': 'uint256', 'name': 'amountLD', 'type': 'uint256' }],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [{ 'internalType': 'address', 'name': '_owner', 'type': 'address' }],
    'name': 'redeemable',
    'outputs': [{ 'internalType': 'uint256', 'name': 'amountLD', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// Интерфейсы для результатов
interface TokenBalance {
  token: string
  symbol: string
  balance: string
  balanceWei: bigint
}

interface LiquidityInfo {
  protocol: string
  hasLiquidity: boolean
  balance: string
  balanceWei: bigint
  tokenAddress: string
}

interface CollectionResult {
  success: boolean
  walletAddress: string
  initialETHBalance: string
  finalETHBalance: string
  collectedTokens: TokenBalance[]
  liquidityFound: LiquidityInfo[]
  withdrawnLiquidity: LiquidityInfo[]
  totalCollected: string
  error?: string
}

export class SoneiumCollector {
  private privateKey: `0x${string}`
  private client: ReturnType<typeof rpcManager.createPublicClient>
  private account: ReturnType<typeof privateKeyToAccount>
  private walletClient: ReturnType<typeof rpcManager.createWalletClient>
  private swap: SoneiumSwap

  constructor (privateKey: `0x${string}`) {
    this.privateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}` as `0x${string}`

    this.account = privateKeyToAccount(this.privateKey)
    this.client = rpcManager.createPublicClient(soneiumChain)
    this.walletClient = rpcManager.createWalletClient(soneiumChain, this.account)

    this.swap = new SoneiumSwap(privateKey)
  }

  /**
   * Получить адрес кошелька
   */
  getWalletAddress (): `0x${string}` {
    return this.account.address
  }

  /**
   * Получить баланс ETH
   */
  async getETHBalance (): Promise<string> {
    const balance = await this.client.getBalance({
      address: this.getWalletAddress()
    })
    return formatEther(balance)
  }

  /**
   * Получить баланс ERC20 токена
   */
  async getTokenBalance (tokenAddress: string): Promise<bigint> {
    try {
      const balance = await this.client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.getWalletAddress()]
      })
      return balance as bigint
    } catch (error) {
      console.log(`Ошибка получения баланса токена ${tokenAddress}:`, error)
      return 0n
    }
  }

  /**
   * Проверить allowance (разрешение) для токена
   */
  async checkAllowance (tokenAddress: string, spenderAddress: string): Promise<bigint> {
    try {
      const allowance = await this.client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [this.getWalletAddress(), spenderAddress as `0x${string}`]
      })
      return allowance as bigint
    } catch (error) {
      console.log(`Ошибка проверки allowance для токена ${tokenAddress}:`, error)
      return 0n
    }
  }

  /**
   * Установить approve для токена на указанную сумму
   */
  async approveToken (tokenAddress: string, spenderAddress: string, amount: bigint): Promise<boolean> {
    try {
      console.log(`🔐 Устанавливаем approve для токена ${tokenAddress}...`)

      const hash = await this.walletClient.writeContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spenderAddress as `0x${string}`, amount],
        account: this.account,
        chain: this.client.chain
      })

      logger.transaction(hash, 'sent', 'COLLECTOR')

      const receipt = await this.client.waitForTransactionReceipt({ hash })
      const success = receipt.status === 'success'

      if (success) {
        console.log(`✅ Approve успешно установлен для токена ${tokenAddress}`)
        // Убираем техническую информацию - gas использован
      } else {
        console.log(`❌ Ошибка установки approve для токена ${tokenAddress}`)
      }

      return success
    } catch (error) {
      console.log(`❌ Ошибка установки approve для токена ${tokenAddress}:`, error)
      return false
    }
  }

  /**
   * Собрать токены USDT и USDC.e в ETH
   */
  async collectTokens (): Promise<TokenBalance[]> {
    const collectedTokens: TokenBalance[] = []
    const walletAddress = this.getWalletAddress()

    // Собираем USDT
    const usdtBalance = await this.getTokenBalance(TOKENS.USDT)
    if (usdtBalance > 0n) {
      console.log(`💰 Найден USDT: ${formatUnits(usdtBalance, 6)}`)

      try {
        const swapResult = await this.swap.getQuote(
          TOKENS.USDT,
          TOKENS.ETH,
          usdtBalance.toString(),
          walletAddress
        )

        if (swapResult.transactionRequest) {
          // Получаем адрес контракта LI.FI из котировки
          const lifiContractAddress = swapResult.transactionRequest.to

          // Проверяем allowance
          const currentAllowance = await this.checkAllowance(TOKENS.USDT, lifiContractAddress)

          if (currentAllowance < usdtBalance) {
            console.log('🔐 Недостаточно allowance для USDT, устанавливаем approve...')
            const approveSuccess = await this.approveToken(TOKENS.USDT, lifiContractAddress, usdtBalance)
            if (!approveSuccess) {
              console.log('❌ Не удалось установить approve для USDT')
              return collectedTokens
            }

            // Задержка после approve
            console.log('⏳ Ожидание 30 секунд после approve...')
            await new Promise(resolve => setTimeout(resolve, 30000))
          }

          const txResult = await this.swap.executeTransaction(swapResult.transactionRequest)
          if (txResult.success) {
            collectedTokens.push({
              token: 'USDT',
              symbol: 'USDT',
              balance: formatUnits(usdtBalance, 6),
              balanceWei: usdtBalance
            })
            console.log('✅ USDT успешно обменян на ETH')

            // Задержка между транзакциями
            console.log('⏳ Ожидание 30 секунд перед следующей транзакцией...')
            await new Promise(resolve => setTimeout(resolve, 30000))
          }
        }
      } catch (error) {
        console.log('❌ Ошибка обмена USDT:', error)
      }
    }

    // Собираем USDC.e
    const usdcBalance = await this.getTokenBalance(TOKENS.USDC_e)
    if (usdcBalance > 0n) {
      console.log(`💰 Найден USDC.e: ${formatUnits(usdcBalance, 6)}`)

      try {
        const swapResult = await this.swap.getQuote(
          TOKENS.USDC_e,
          TOKENS.ETH,
          usdcBalance.toString(),
          walletAddress
        )

        if (swapResult.transactionRequest) {
          // Получаем адрес контракта LI.FI из котировки
          const lifiContractAddress = swapResult.transactionRequest.to

          // Проверяем allowance
          const currentAllowance = await this.checkAllowance(TOKENS.USDC_e, lifiContractAddress)

          if (currentAllowance < usdcBalance) {
            console.log('🔐 Недостаточно allowance для USDC.e, устанавливаем approve...')
            const approveSuccess = await this.approveToken(TOKENS.USDC_e, lifiContractAddress, usdcBalance)
            if (!approveSuccess) {
              console.log('❌ Не удалось установить approve для USDC.e')
              return collectedTokens
            }

            // Задержка после approve
            console.log('⏳ Ожидание 30 секунд после approve...')
            await new Promise(resolve => setTimeout(resolve, 30000))
          }

          const txResult = await this.swap.executeTransaction(swapResult.transactionRequest)
          if (txResult.success) {
            collectedTokens.push({
              token: 'USDC.e',
              symbol: 'USDC.e',
              balance: formatUnits(usdcBalance, 6),
              balanceWei: usdcBalance
            })
            console.log('✅ USDC.e успешно обменян на ETH')

            // Задержка между транзакциями
            console.log('⏳ Ожидание 30 секунд перед следующей транзакцией...')
            await new Promise(resolve => setTimeout(resolve, 30000))
          }
        }
      } catch (error) {
        console.log('❌ Ошибка обмена USDC.e:', error)
      }
    }

    return collectedTokens
  }

  /**
   * Проверить ликвидность в протоколе Aave
   */
  async checkAaveLiquidity (): Promise<LiquidityInfo> {
    try {
      const balance = await this.getTokenBalance(PROTOCOL_CONTRACTS.AAVE_A_TOKEN)
      return {
        protocol: 'Aave',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, 6),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.AAVE_A_TOKEN
      }
    } catch (error) {
      console.log('Ошибка проверки ликвидности Aave:', error)
      return {
        protocol: 'Aave',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.AAVE_A_TOKEN
      }
    }
  }

  /**
   * Проверить ликвидность в протоколе Morpho
   */
  async checkMorphoLiquidity (): Promise<LiquidityInfo> {
    try {
      const balance = await this.getTokenBalance(PROTOCOL_CONTRACTS.MORPHO_METAMORPHO)

      // Получаем правильные decimals для токена Morpho
      const decimals = await this.client.readContract({
        address: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals'
      })

      return {
        protocol: 'Morpho',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, decimals as number),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO
      }
    } catch (error) {
      console.log('Ошибка проверки ликвидности Morpho:', error)
      return {
        protocol: 'Morpho',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO
      }
    }
  }

  /**
   * Проверить ликвидность в протоколе Stargate
   */
  async checkStargateLiquidity (): Promise<LiquidityInfo> {
    try {
      const redeemable = await this.client.readContract({
        address: PROTOCOL_CONTRACTS.STARGATE_POOL as `0x${string}`,
        abi: STARGATE_ABI,
        functionName: 'redeemable',
        args: [this.getWalletAddress()]
      })

      const balance = redeemable as bigint
      return {
        protocol: 'Stargate',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, 6),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.STARGATE_POOL
      }
    } catch (error) {
      console.log('Ошибка проверки ликвидности Stargate:', error)
      return {
        protocol: 'Stargate',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.STARGATE_POOL
      }
    }
  }

  /**
   * Проверить ликвидность в протоколе Sake Finance
   */
  async checkSakeFinanceLiquidity (): Promise<LiquidityInfo> {
    try {
      const balance = await this.getTokenBalance(PROTOCOL_CONTRACTS.SAKE_ATOKEN)
      return {
        protocol: 'Sake Finance',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, 6),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.SAKE_ATOKEN
      }
    } catch (error) {
      console.log('Ошибка проверки ликвидности Sake Finance:', error)
      return {
        protocol: 'Sake Finance',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.SAKE_ATOKEN
      }
    }
  }

  /**
   * Проверить ликвидность в Untitled Bank
   */
  async checkUntitledBankLiquidity (): Promise<LiquidityInfo> {
    try {
      const balance = await this.client.readContract({
        address: PROTOCOL_CONTRACTS.UNTITLED_BANK,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.account.address]
      })

      const hasLiquidity = balance > 0n

      return {
        protocol: 'Untitled Bank',
        hasLiquidity,
        balance: hasLiquidity ? formatUnits(balance, 6) : '0',
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.UNTITLED_BANK
      }
    } catch (error) {
      console.error('Ошибка проверки ликвидности Untitled Bank:', error)
      return {
        protocol: 'Untitled Bank',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.UNTITLED_BANK
      }
    }
  }

  /**
   * Проверить ликвидность во всех протоколах
   */
  async checkAllLiquidity (): Promise<LiquidityInfo[]> {
    console.log('🔍 Проверяем ликвидность во всех протоколах...')

    const [aave, morpho, stargate, sake, untitledBank] = await Promise.all([
      this.checkAaveLiquidity(),
      this.checkMorphoLiquidity(),
      this.checkStargateLiquidity(),
      this.checkSakeFinanceLiquidity(),
      this.checkUntitledBankLiquidity()
    ])

    const liquidityInfo = [aave, morpho, stargate, sake, untitledBank]
    const foundLiquidity = liquidityInfo.filter(info => info.hasLiquidity)

    console.log(`📊 Найдена ликвидность в ${foundLiquidity.length} протоколах:`)
    foundLiquidity.forEach(info => {
      console.log(`   - ${info.protocol}: ${info.balance} токенов`)
    })

    return liquidityInfo
  }

  /**
   * Вывести ликвидность из протокола Aave
   */
  async withdrawFromAave (): Promise<boolean> {
    try {

      // Используем улучшенную функцию из модуля AAVE с gas estimation и retry
      const transactionHash = await redeemAaveLiquidity(this.privateKey)

      if (transactionHash) {
        console.log('✅ Ликвидность успешно выведена из Aave')
        console.log(`🔗 Хеш транзакции: ${transactionHash}`)
        return true
      } else {
        console.log('❌ Ошибка вывода ликвидности из Aave')
        return false
      }
    } catch (error) {
      console.log('❌ Ошибка вывода из Aave:', error)
      return false
    }
  }

  /**
   * Вывести ликвидность из протокола Morpho
   */
  async withdrawFromMorpho (amount: bigint): Promise<boolean> {
    try {
      // Получаем рекомендуемый лимит газа и увеличиваем на 50%
      const estimatedGas = await this.client.estimateContractGas({
        address: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: 'redeem',
        args: [amount, this.getWalletAddress(), this.getWalletAddress()],
        account: this.account
      })

      const gasLimit = BigInt(Math.floor(Number(estimatedGas) * 1.5))

      const hash = await this.walletClient.writeContract({
        address: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: 'redeem',
        args: [amount, this.getWalletAddress(), this.getWalletAddress()],
        account: this.account,
        chain: this.client.chain,
        gas: gasLimit
      })

      const receipt = await this.client.waitForTransactionReceipt({ hash })
      return receipt.status === 'success'
    } catch (error) {
      console.log('Ошибка вывода из Morpho:', error)
      return false
    }
  }

  /**
   * Вывести ликвидность из протокола Stargate
   */
  async withdrawFromStargate (amount: bigint): Promise<boolean> {
    try {
      // Получаем рекомендуемый лимит газа и увеличиваем на 50%
      const estimatedGas = await this.client.estimateContractGas({
        address: PROTOCOL_CONTRACTS.STARGATE_POOL as `0x${string}`,
        abi: STARGATE_ABI,
        functionName: 'redeem',
        args: [amount, this.getWalletAddress()],
        account: this.account
      })

      const gasLimit = BigInt(Math.floor(Number(estimatedGas) * 1.5))

      const hash = await this.walletClient.writeContract({
        address: PROTOCOL_CONTRACTS.STARGATE_POOL as `0x${string}`,
        abi: STARGATE_ABI,
        functionName: 'redeem',
        args: [amount, this.getWalletAddress()],
        account: this.account,
        chain: this.client.chain,
        gas: gasLimit
      })

      const receipt = await this.client.waitForTransactionReceipt({ hash })
      return receipt.status === 'success'
    } catch (error) {
      console.log('Ошибка вывода из Stargate:', error)
      return false
    }
  }

  /**
   * Вывести ликвидность из всех протоколов
   */
  async withdrawAllLiquidity (liquidityInfo: LiquidityInfo[]): Promise<LiquidityInfo[]> {
    const withdrawnLiquidity: LiquidityInfo[] = []

    for (const info of liquidityInfo) {
      if (!info.hasLiquidity || info.balanceWei === 0n) continue

      console.log(`💸 Выводим ликвидность из ${info.protocol}...`)
      let success = false

      switch (info.protocol) {
      case 'Aave':
        success = await this.withdrawFromAave()
        break
      case 'Morpho':
        success = await this.withdrawFromMorpho(info.balanceWei)
        break
      case 'Stargate':
        success = await this.withdrawFromStargate(info.balanceWei)
        break
      case 'Sake Finance':
        // Для Sake Finance используем стандартный ERC20 transfer
        success = await this.withdrawFromSakeFinance()
        break
      case 'Untitled Bank':
        success = await this.withdrawFromUntitledBank()
        break
      }

      if (success) {
        withdrawnLiquidity.push(info)
        console.log(`✅ Ликвидность успешно выведена из ${info.protocol}`)
      } else {
        console.log(`❌ Ошибка вывода ликвидности из ${info.protocol}`)
      }
    }

    return withdrawnLiquidity
  }

  /**
   * Вывести ликвидность из Sake Finance (ERC20 токен)
   */
  async withdrawFromSakeFinance (): Promise<boolean> {
    try {
      console.log('💸 Выводим ликвидность из Sake Finance...')

      // Используем функцию redeemLiquidity из модуля sake-finance
      const transactionHash = await redeemLiquidity(this.privateKey)

      if (transactionHash) {
        console.log('✅ Ликвидность успешно выведена из Sake Finance')
        console.log(`🔗 Хеш транзакции: ${transactionHash}`)
        return true
      } else {
        console.log('❌ Ошибка вывода ликвидности из Sake Finance')
        return false
      }
    } catch (error) {
      console.log('❌ Ошибка вывода из Sake Finance:', error)
      return false
    }
  }

  /**
   * Вывести ликвидность из Untitled Bank
   */
  async withdrawFromUntitledBank (): Promise<boolean> {
    try {
      console.log('💸 Выводим ликвидность из Untitled Bank...')

      // Используем функцию withdraw из модуля untitled-bank
      const transactionHash = await withdrawFromUntitledBank(this.privateKey)

      if (transactionHash) {
        console.log('✅ Ликвидность успешно выведена из Untitled Bank')
        console.log(`🔗 Хеш транзакции: ${transactionHash}`)
        return true
      } else {
        console.log('❌ Ошибка вывода ликвидности из Untitled Bank')
        return false
      }
    } catch (error) {
      console.log('❌ Ошибка вывода из Untitled Bank:', error)
      return false
    }
  }

  /**
   * Основная функция сбора
   */
  async performCollection (): Promise<CollectionResult> {
    try {
      console.log('🚀 Запуск модуля сборщика...')
      const walletAddress = this.getWalletAddress()
      console.log(`📍 Адрес кошелька: ${walletAddress}`)

      // Получаем начальный баланс ETH
      const initialETHBalance = await this.getETHBalance()
      console.log(`💰 Начальный баланс ETH: ${initialETHBalance}`)

      // 1. Проверяем ликвидность во всех протоколах
      console.log('🔄 Этап 1: Проверка ликвидности...')
      const liquidityInfo = await this.checkAllLiquidity()

      // 2. Выводим найденную ликвидность
      console.log('🔄 Этап 2: Вывод ликвидности...')
      const withdrawnLiquidity = await this.withdrawAllLiquidity(liquidityInfo)

      // 3. Собираем токены USDT и USDC.e в ETH
      console.log('🔄 Этап 3: Сбор токенов...')
      const collectedTokens = await this.collectTokens()

      // Получаем финальный баланс ETH
      const finalETHBalance = await this.getETHBalance()
      const totalCollected = (parseFloat(finalETHBalance) - parseFloat(initialETHBalance)).toString()

      console.log('🎉 Сбор завершен!')
      console.log(`💰 Финальный баланс ETH: ${finalETHBalance}`)
      console.log(`📈 Всего собрано: ${totalCollected} ETH`)

      return {
        success: true,
        walletAddress,
        initialETHBalance,
        finalETHBalance,
        collectedTokens,
        liquidityFound: liquidityInfo.filter(info => info.hasLiquidity),
        withdrawnLiquidity,
        totalCollected
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      console.error('❌ Ошибка в модуле сборщика:', errorMessage)
      return {
        success: false,
        walletAddress: this.getWalletAddress(),
        initialETHBalance: '0',
        finalETHBalance: '0',
        collectedTokens: [],
        liquidityFound: [],
        withdrawnLiquidity: [],
        totalCollected: '0',
        error: errorMessage
      }
    }
  }
}

/**
 * Основная функция модуля сборщика
 */
export async function performCollection (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  initialETHBalance?: string
  finalETHBalance?: string
  totalCollected?: string
  collectedTokensCount?: number
  liquidityFoundCount?: number
  withdrawnLiquidityCount?: number
  error?: string
}> {
  try {
    logger.moduleStart('Soneium Collector')

    const collector = new SoneiumCollector(privateKey)
    const result = await collector.performCollection()

    if (result.success) {
      logger.success('Модуль сборщика выполнен успешно!')
      logger.balance('ETH', `${result.initialETHBalance} ETH`, result.walletAddress)
      logger.info(`Финальный баланс: ${result.finalETHBalance} ETH`)
      logger.info(`Всего собрано: ${result.totalCollected} ETH`)
      logger.info(`Собрано токенов: ${result.collectedTokens.length}`)
      logger.info(`Найдена ликвидность в: ${result.liquidityFound.length} протоколах`)
      logger.info(`Выведена ликвидность из: ${result.withdrawnLiquidity.length} протоколов`)

      return {
        success: true,
        walletAddress: result.walletAddress,
        initialETHBalance: result.initialETHBalance,
        finalETHBalance: result.finalETHBalance,
        totalCollected: result.totalCollected,
        collectedTokensCount: result.collectedTokens.length,
        liquidityFoundCount: result.liquidityFound.length,
        withdrawnLiquidityCount: result.withdrawnLiquidity.length
      }
    } else {
      console.log('❌ ОШИБКА МОДУЛЯ СБОРЩИКА:')
      console.log(`   ${result.error}`)
      return {
        success: false,
        error: result.error || 'Неизвестная ошибка'
      }
    }

  } catch (error) {
    logger.moduleEnd('Soneium Collector', false)
    logger.error('Критическая ошибка модуля сборщика', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
