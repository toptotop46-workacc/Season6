import { privateKeyToAccount } from 'viem/accounts'
import { TransactionChecker } from './modules/transaction-checker.js'
import { POINTS_LIMIT_SEASON } from './season-config.js'
import { logger } from './logger.js'
import { GasChecker } from './gas-checker.js'

// Импорт всех модулей
import { performLiquidityManagement as performAaveLiquidity } from './modules/aave.js'
import { performArkadaCheckin } from './modules/arkada-checkin.js'
import { performCollection } from './modules/collector.js'
import { performLootcoinCheckin } from './modules/lootcoin.js'
import { performJumperSwap } from './modules/jumper.js'
import { performMorphoLiquidityManagement } from './modules/morpho.js'
import { performSakeFinanceOperations } from './modules/sake-finance.js'
import { performLiquidityManagement as performStargateLiquidity } from './modules/stargate.js'
import { performDepositManagement } from './modules/untitled-bank.js'
import { performRevoke } from './modules/revoke.js'
import { performRedButtonNoob } from './modules/redbutton-noob.js'
import { performHarkan } from './modules/harkan.js'
import { performVelodrome } from './modules/velodrome.js'
import { performWowmax } from './modules/wowmax.js'

// Интерфейс для результата выполнения модуля
interface ModuleResult {
  success: boolean
  walletAddress?: string
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  skipped?: boolean // Флаг пропуска кошелька (не ошибка)
  reason?: string // Причина пропуска
  // Дополнительные поля для конкретных модулей
  ethBalance?: string
  swapAmount?: string
  targetToken?: string
  usdcBalance?: string
  aTokenBalance?: string
  morphoBalance?: string
  redeemableBalance?: string
  bankBalance?: string
  streak?: number
  blockNumber?: bigint
  // Поля для Sake Finance
  initialUsdcBalance?: string
  initialATokenBalance?: string
  finalUsdcBalance?: string
  finalATokenBalance?: string
  withdrawTransactionHash?: string | null
  supplyTransactionHash?: string | null
  finalWithdrawTransactionHash?: string | null
  depositAmount?: string
  message?: string
  // Поля для других модулей
  depositTransactionHash?: string
  redeemTransactionHash?: string | null
  withdrawTxHash?: string
  // Поля для автоматической покупки USDC.e
  usdcPurchased?: boolean
  usdcPurchaseHash?: string | undefined
  usdcPurchaseAmount?: string | undefined
  [key: string]: unknown
}

// Типы для модулей
interface Module {
  name: string
  description: string
  execute: (privateKey: `0x${string}`) => Promise<ModuleResult>
}

// Интерфейс для задачи кошелька
interface WalletTask {
  walletIndex: number
  privateKey: `0x${string}`
  walletAddress: string
  assignedModule: Module
}

// Результат выполнения потока
interface ThreadResult {
  threadId: number
  success: boolean
  walletAddress: string
  moduleName: string
  executionTime: number
  transactionHash?: string | undefined
  explorerUrl?: string | null | undefined
  error?: string | undefined
}

/**
 * Класс для параллельного выполнения модулей
 */
export class ParallelExecutor {
  private transactionChecker: TransactionChecker | null = null
  private iteration: number = 1
  private moduleOffset: number = 0 // Смещение для циклического перебора модулей

  // Список активных кошельков для текущей итерации
  private currentIterationWallets: { privateKey: `0x${string}`, address: string }[] = []

  // Отслеживание ежедневных транзакций для streak
  private lastTransactionDates: Map<string, string> = new Map() // address -> date string (YYYY-MM-DD)

  // 🆕 Кэш для приватных ключей - чтобы не запрашивать пароль каждый раз
  private cachedPrivateKeys: `0x${string}`[] | null = null

  // Предвыбранные кошельки для работы (если null - используется автоматический выбор)
  private preselectedWallets: { privateKey: `0x${string}`, address: string }[] | null = null

  // Исключенные модули (имена модулей, которые не будут использоваться)
  private excludedModules: string[] = []

  // Конфигурация для выбора кошельков
  private readonly WALLET_SELECTION_CONFIG = {
    maxCheckAttempts: 5,        // Максимум батчей для проверки (5 * threadCount кошельков)
    batchSizeMultiplier: 1,     // Множитель размера батча (1 = threadCount, 2 = 2*threadCount)
    minActiveWallets: 0         // Минимум активных кошельков для продолжения работы (0 = всегда продолжать)
  }

  // Список всех доступных модулей
  private readonly modules: Module[] = [
    {
      name: 'Aave',
      description: 'Управление ликвидностью в протоколе Aave',
      execute: performAaveLiquidity
    },
    {
      name: 'Arkada Check-in',
      description: 'Ежедневный check-in в Arkada',
      execute: performArkadaCheckin
    },
    {
      name: 'Lootcoin Check-in',
      description: 'Ежедневный check-in в Lootcoin',
      execute: performLootcoinCheckin
    },
    {
      name: 'Collector',
      description: 'Сбор токенов и проверка ликвидности во всех протоколах',
      execute: performCollection
    },
    {
      name: 'Jumper',
      description: 'Свапы токенов через LI.FI',
      execute: performJumperSwap
    },
    {
      name: 'Morpho',
      description: 'Управление ликвидностью в протоколе Morpho',
      execute: performMorphoLiquidityManagement
    },
    {
      name: 'Sake Finance',
      description: 'Операции в протоколе Sake Finance',
      execute: performSakeFinanceOperations
    },
    {
      name: 'Stargate',
      description: 'Управление ликвидностью в протоколе Stargate',
      execute: performStargateLiquidity
    },
    {
      name: 'Untitled Bank',
      description: 'Управление депозитами в Untitled Bank',
      execute: performDepositManagement
    },
    {
      name: 'Revoke',
      description: 'Отзыв всех апрувов для кошелька',
      execute: performRevoke
    },
    {
      name: 'RedButton Noob',
      description: 'Выполнение 1-3 транзакций в режиме noob с задержкой 10-20 секунд',
      execute: performRedButtonNoob
    },
    {
      name: 'Harkan',
      description: 'Один спин в Harkan (cyber-roulette)',
      execute: performHarkan
    },
    {
      name: 'Velodrome',
      description: 'Свап ETH → USDC.e (0.1–1% от баланса) через Velodrome',
      execute: performVelodrome
    },
    {
      name: 'WOWMAX',
      description: 'Свап ETH → USDC.e (0.1–1% от баланса) через WOWMAX',
      execute: performWowmax
    }
  ]

  constructor (transactionChecker: TransactionChecker | null) {
    this.transactionChecker = transactionChecker
  }

  /**
   * Устанавливает предвыбранные кошельки для работы
   */
  setPreselectedWallets (wallets: { privateKey: `0x${string}`, address: string }[]): void {
    this.preselectedWallets = wallets
  }

  /**
   * Очищает предвыбранные кошельки
   */
  clearPreselectedWallets (): void {
    this.preselectedWallets = null
  }

  /**
   * Получает список активных (неисключенных) модулей
   */
  private getActiveModules (): Module[] {
    return this.modules.filter(module => !this.excludedModules.includes(module.name))
  }

  /**
   * Устанавливает список исключенных модулей
   */
  setExcludedModules (moduleNames: string[]): void {
    // Валидация: должен остаться хотя бы 1 активный модуль
    const wouldBeActive = this.modules.length - moduleNames.length
    if (wouldBeActive < 1) {
      throw new Error('Нельзя исключить все модули. Должен остаться хотя бы 1 активный модуль.')
    }

    // Фильтруем только существующие имена модулей
    const validModuleNames = this.modules.map(m => m.name)
    const filteredNames = moduleNames.filter(name => validModuleNames.includes(name))

    this.excludedModules = filteredNames
  }

  /**
   * Очищает список исключенных модулей
   */
  clearExcludedModules (): void {
    this.excludedModules = []
  }

  /**
   * Возвращает список исключенных модулей
   */
  getExcludedModules (): string[] {
    return [...this.excludedModules]
  }

  /**
   * Возвращает список всех доступных модулей
   */
  getAvailableModules (): Module[] {
    return [...this.modules]
  }

  /**
   * Проверяет, делал ли кошелек транзакцию сегодня
   */
  private hasTransactedToday (address: string): boolean {
    const lastDate = this.lastTransactionDates.get(address)
    const today = new Date().toISOString().split('T')[0]!
    return lastDate === today
  }

  /**
   * Отмечает, что кошелек сделал транзакцию сегодня
   */
  private markTransactionToday (address: string): void {
    const today = new Date().toISOString().split('T')[0]!
    this.lastTransactionDates.set(address, today)
  }

  /**
   * Получает кошельки, которым нужен streak сегодня
   */
  private getWalletsNeedingStreakToday (wallets: { privateKey: `0x${string}`, address: string }[]): { privateKey: `0x${string}`, address: string }[] {
    return wallets.filter(w => !this.hasTransactedToday(w.address))
  }

  /**
   * Выбирает активные кошельки для текущей итерации с проверкой поинтов
   * Продолжает проверку батчами, пока не найдет нужное количество активных кошельков
   */
  private async selectRandomWalletsForIteration (threadCount: number): Promise<void> {
    try {
      // Если есть предвыбранные кошельки, используем их
      if (this.preselectedWallets && this.preselectedWallets.length > 0) {
        console.log(`Используем ${this.preselectedWallets.length} предвыбранных кошельков...`)

        // Ограничиваем количество кошельков количеством потоков
        const actualThreadCount = Math.min(threadCount, this.preselectedWallets.length)

        if (actualThreadCount < threadCount) {
          console.log(`⚠️  Предвыбранных кошельков (${actualThreadCount}) меньше чем потоков (${threadCount})`)
          console.log(`📊 Будет запущено ${actualThreadCount} потоков`)
        }

        // Приоритет кошелькам без транзакций сегодня
        const walletsNeedingStreak = this.getWalletsNeedingStreakToday(this.preselectedWallets)

        if (walletsNeedingStreak.length > 0) {
          // Сначала берем кошельки, которым нужен streak
          const priorityCount = Math.min(actualThreadCount, walletsNeedingStreak.length)
          this.currentIterationWallets = walletsNeedingStreak.slice(0, priorityCount)

          // Если остались свободные потоки, добавляем остальные кошельки
          if (priorityCount < actualThreadCount) {
            const remaining = this.preselectedWallets
              .filter(w => !walletsNeedingStreak.includes(w))
              .slice(0, actualThreadCount - priorityCount)
            this.currentIterationWallets.push(...remaining)
          }

          console.log(`🎯 Приоритет streak: ${walletsNeedingStreak.length} кошельков нуждаются в транзакции сегодня`)
        } else {
          // Все кошельки уже сделали streak сегодня, работаем в обычном режиме
          this.currentIterationWallets = this.preselectedWallets.slice(0, actualThreadCount)
          console.log('✅ Все кошельки выполнили streak сегодня, работаем в обычном режиме')
        }

        console.log(`✅ Выбрано ${this.currentIterationWallets.length} кошельков для работы`)
        return
      }

      // Иначе используем автоматический выбор активных кошельков
      console.log(`Выбираем ${threadCount} активных кошельков...`)

      // 1. Получаем все приватные ключи
      const allPrivateKeys = await this.getAllPrivateKeys()
      const allAddresses = allPrivateKeys.map(pk => privateKeyToAccount(pk).address)

      // 2. Перемешиваем все кошельки для случайного выбора
      const shuffled = [...allAddresses].sort(() => Math.random() - 0.5)

      // 3. Проверяем кошельки батчами до нахождения нужного количества активных
      const batchSize = threadCount * this.WALLET_SELECTION_CONFIG.batchSizeMultiplier
      let allActiveWallets: string[] = []
      let allCompletedWallets: string[] = []
      let checkedCount = 0
      let attempt = 0

      while (
        allActiveWallets.length < threadCount &&
        attempt < this.WALLET_SELECTION_CONFIG.maxCheckAttempts &&
        checkedCount < shuffled.length
      ) {
        attempt++
        const startIndex = checkedCount
        const endIndex = Math.min(startIndex + batchSize, shuffled.length)
        const walletsToCheck = shuffled.slice(startIndex, endIndex)

        if (walletsToCheck.length === 0) {
          break
        }

        console.log(`Проверяем батч #${attempt}: ${walletsToCheck.length} кошельков через API...`)
        const { activeWallets, completedWallets } = await this.transactionChecker!.checkWallets(walletsToCheck)

        allActiveWallets.push(...activeWallets)
        allCompletedWallets.push(...completedWallets)
        checkedCount += walletsToCheck.length

        console.log(`📊 Батч #${attempt}: Активных ${activeWallets.length}/${walletsToCheck.length}, Завершенных ${completedWallets.length}/${walletsToCheck.length}`)
        console.log(`📊 Всего проверено: ${checkedCount} кошельков, найдено активных: ${allActiveWallets.length}`)

        // Если все проверенные в этом батче завершены, но еще есть кошельки для проверки
        if (activeWallets.length === 0 && checkedCount < shuffled.length) {
          console.log(`⚠️  Все кошельки в батче #${attempt} имеют >= ${POINTS_LIMIT_SEASON} поинтов, проверяем следующий батч...`)
        }
      }

      // 4. Если не нашли достаточно активных кошельков после всех проверок
      if (allActiveWallets.length === 0) {
        console.log(`⚠️  Не найдено активных кошельков после проверки ${checkedCount} кошельков`)
        console.log(`📊 Все проверенные кошельки имеют >= ${POINTS_LIMIT_SEASON} поинтов, пропускаем итерацию`)
        this.currentIterationWallets = []
        return
      }

      // 5. Выбираем кошельки для работы (только активные, максимум threadCount)
      const actualThreadCount = Math.min(threadCount, allActiveWallets.length)

      if (actualThreadCount < threadCount) {
        console.log(`⚠️  Активных кошельков (${actualThreadCount}) меньше чем потоков (${threadCount})`)
        console.log(`📊 Будет запущено ${actualThreadCount} потоков`)
      }

      // Перемешиваем и выбираем активные кошельки
      const shuffledActive = [...allActiveWallets].sort(() => Math.random() - 0.5).slice(0, actualThreadCount)
      const activeWalletsWithKeys = shuffledActive.map(addr => {
        const pk = allPrivateKeys.find(k => privateKeyToAccount(k).address === addr)!
        return { privateKey: pk, address: addr }
      })

      // 6. Приоритет кошелькам без транзакций сегодня
      const walletsNeedingStreak = this.getWalletsNeedingStreakToday(activeWalletsWithKeys)

      if (walletsNeedingStreak.length > 0) {
        // Сначала берем кошельки, которым нужен streak
        const priorityCount = Math.min(actualThreadCount, walletsNeedingStreak.length)
        this.currentIterationWallets = walletsNeedingStreak.slice(0, priorityCount)

        // Если остались свободные потоки, добавляем остальные кошельки
        if (priorityCount < actualThreadCount) {
          const remaining = activeWalletsWithKeys
            .filter(w => !walletsNeedingStreak.includes(w))
            .slice(0, actualThreadCount - priorityCount)
          this.currentIterationWallets.push(...remaining)
        }

        console.log(`🎯 Приоритет streak: ${walletsNeedingStreak.length} кошельков нуждаются в транзакции сегодня`)
      } else {
        // Все кошельки уже сделали streak сегодня, работаем в обычном режиме
        this.currentIterationWallets = activeWalletsWithKeys.slice(0, actualThreadCount)
        console.log('✅ Все кошельки выполнили streak сегодня, работаем в обычном режиме')
      }

      console.log(`✅ Выбрано ${this.currentIterationWallets.length} активных кошельков для работы`)

    } catch (error) {
      console.error('❌ Ошибка при выборе кошельков для итерации:', error)
      // В случае ошибки используем случайные кошельки без проверки
      const allPrivateKeys = await this.getAllPrivateKeys()
      const randomKeys = allPrivateKeys.slice(0, threadCount)
      this.currentIterationWallets = randomKeys.map(key => ({
        privateKey: key,
        address: privateKeyToAccount(key).address
      }))
    }
  }

  /**
   * Выполнение уникальных действий для всех кошельков (одноразово)
   */
  async executeUniqueActions (maxConcurrent: number = 10): Promise<void> {
    try {
      console.log('\n🎯 РЕЖИМ УНИКАЛЬНЫХ ДЕЙСТВИЙ')
      console.log('='.repeat(50))

      // Получаем все кошельки
      const allWallets = await this.getAllWallets()
      console.log(`📊 Всего кошельков: ${allWallets.length}`)
      console.log(`🔄 Максимум потоков: ${maxConcurrent}`)

      // Распределяем модули между кошельками
      const walletTasks = this.distributeModulesToWallets(allWallets)

      // Показываем карту распределения
      this.showDistributionMap(walletTasks)

      // Выполняем задачи с ограничением потоков
      await this.executeTasksWithConcurrency(walletTasks, maxConcurrent)
    } catch (error) {
      console.error('\n❌ Ошибка в режиме уникальных действий:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      throw error
    }
  }

  /**
   * Основной метод - бесконечный цикл с параллельным выполнением
   */
  async executeInfiniteLoop (threadCount: number, gasChecker?: GasChecker): Promise<void> {
    try {
      // 🆕 ИНИЦИАЛИЗИРУЕМ КЭШ КЛЮЧЕЙ ДО НАЧАЛА ЦИКЛА
      // Это гарантирует, что пароль будет запрошен только один раз в начале,
      // а не после долгого ожидания газа
      await this.getAllPrivateKeys()

      while (true) {
        try {
          console.log(`\n🔄 ИТЕРАЦИЯ #${this.iteration}`)
          console.log('='.repeat(50))

          // 🆕 ПРОВЕРКА ГАЗА В НАЧАЛЕ ИТЕРАЦИИ
          if (gasChecker) {
            await this.checkGasPrice(gasChecker)
          }

          await this.executeIteration(threadCount)

          // Пауза между итерациями (5 секунд)
          console.log('\n⏳ Пауза 5 секунд до следующей итерации...')
          await new Promise(resolve => setTimeout(resolve, 5000))

          this.iteration++

        } catch (error) {
          console.error(`\n❌ Ошибка в итерации #${this.iteration}:`, error instanceof Error ? error.message : 'Неизвестная ошибка')

          // Пауза при ошибке (1 секунда)
          console.log('⏳ Пауза 1 секунда после ошибки...')
          await new Promise(resolve => setTimeout(resolve, 1000))

          this.iteration++
        }
      }
    } catch (error) {
      console.error('\n💥 КРИТИЧЕСКАЯ ОШИБКА В БЕСКОНЕЧНОМ ЦИКЛЕ:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      throw error
    }
  }

  /**
   * Выполнение одной итерации с параллельными потоками
   */
  private async executeIteration (threadCount: number): Promise<void> {
    const startTime = Date.now()

    // Проверяем, что есть хотя бы 1 активный модуль
    const activeModules = this.getActiveModules()
    if (activeModules.length === 0) {
      throw new Error('Нет доступных модулей для работы. Все модули исключены.')
    }

    // Показываем информацию об исключенных модулях, если они есть
    if (this.excludedModules.length > 0) {
      console.log(`\n📋 Исключенные модули: ${this.excludedModules.join(', ')}`)
      console.log(`📊 Активных модулей: ${activeModules.length} из ${this.modules.length}`)
    }

    // Выбираем случайные кошельки для текущей итерации
    await this.selectRandomWalletsForIteration(threadCount)

    // Проверяем, есть ли активные кошельки для работы
    if (this.currentIterationWallets.length === 0) {
      console.log('⚠️  Нет активных кошельков для работы, пропускаем итерацию')
      console.log('📊 Итерация завершена, продолжаем работу...')
      return
    }

    // Ограничиваем количество потоков количеством доступных кошельков
    const actualThreadCount = Math.min(threadCount, this.currentIterationWallets.length)

    if (actualThreadCount < threadCount) {
      console.log(`⚠️ Доступно только ${actualThreadCount} активных кошельков из ${threadCount} запрошенных потоков`)
    }

    const threadPromises: Promise<ThreadResult>[] = []

    // Создаем промисы только для доступного количества кошельков
    for (let threadId = 1; threadId <= actualThreadCount; threadId++) {
      threadPromises.push(this.executeThread(threadId))
    }

    // Ждем завершения всех потоков
    const results = await Promise.allSettled(threadPromises)
    const endTime = Date.now()
    const totalTime = (endTime - startTime) / 1000

    // Обрабатываем результаты
    const threadResults: ThreadResult[] = []
    let successCount = 0
    let errorCount = 0

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        threadResults.push(result.value)
        if (result.value.success) {
          successCount++
        } else {
          errorCount++
        }
      } else {
        errorCount++
        threadResults.push({
          threadId: index + 1,
          success: false,
          walletAddress: 'unknown',
          moduleName: 'unknown',
          executionTime: 0,
          error: result.reason instanceof Error ? result.reason.message : 'Неизвестная ошибка'
        })
      }
    })

    // Показываем результаты итерации
    this.showIterationResults(threadResults, successCount, errorCount, totalTime)

    // Обновляем смещение для следующей итерации (циклический перебор модулей)
    if (activeModules.length > 0) {
      this.moduleOffset = (this.moduleOffset + threadCount) % activeModules.length
    }
  }

  /**
   * Выполнение одного потока в итерации
   */
  private async executeThread (threadId: number): Promise<ThreadResult> {
    const startTime = Date.now()

    try {
      // Получаем кошелек с приоритетом неактивных
      const privateKey = await this.selectWalletWithPriority()

      // Создаем account для получения адреса
      const account = privateKeyToAccount(privateKey)

      // Выбираем уникальный модуль для потока
      const module = this.getUniqueModule(threadId)

      console.log(`\n📊 ПОТОК #${threadId}:`)
      console.log('-'.repeat(30))
      console.log(`📍 Адрес кошелька: ${account.address}`)
      console.log(`🎯 Модуль: ${module.name}`)
      console.log(`📝 Описание: ${module.description}`)

      // Специальная обработка для Jumper модуля (rate limit protection)
      if (module.name === 'Jumper') {
        // Убираем техническую информацию - задержка rate limit
        await new Promise(resolve => setTimeout(resolve, 2000)) // 2 секунды задержки
      }

      // Выполняем модуль
      const result = await module.execute(privateKey)
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      // Отмечаем транзакцию после успешного выполнения
      if (result.success) {
        this.markTransactionToday(account.address)
      }

      // Если кошелек пропущен (skipped), это не ошибка
      const isSkipped = result.skipped === true
      const isSuccess = result.success || isSkipped

      return {
        threadId,
        success: isSuccess,
        walletAddress: account.address,
        moduleName: module.name,
        executionTime,
        transactionHash: result.transactionHash,
        explorerUrl: result.explorerUrl,
        error: isSkipped ? undefined : result.error
      }

    } catch (error) {
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      return {
        threadId,
        success: false,
        walletAddress: 'unknown',
        moduleName: 'unknown',
        executionTime,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      }
    }
  }

  /**
   * Выбирает кошелек из предварительно проверенного списка для текущей итерации
   * Использует циклический перебор для равномерного распределения нагрузки
   */
  private async selectWalletWithPriority (recursionDepth: number = 0): Promise<`0x${string}`> {
    try {
      // Защита от бесконечной рекурсии
      if (recursionDepth > 5) {
        console.log('⚠️ Достигнут лимит рекурсии, используем случайный выбор')
        return await this.getRandomPrivateKey()
      }

      // Если нет активных кошельков для текущей итерации
      if (this.currentIterationWallets.length === 0) {
        console.log('⚠️ Нет активных кошельков для текущей итерации, используем случайный выбор')
        return await this.getRandomPrivateKey()
      }

      // Используем циклический перебор вместо случайного выбора
      // Это обеспечивает равномерное распределение нагрузки между проверенными активными кошельками
      const selectedWallet = this.currentIterationWallets[0]!

      // Удаляем выбранный кошелек из списка, чтобы избежать повторного выбора
      this.currentIterationWallets.shift()

      return selectedWallet.privateKey

    } catch (error) {
      console.error('❌ Ошибка при выборе кошелька:', error)
      console.log('🔄 Fallback на случайный выбор')
      return await this.getRandomPrivateKey()
    }
  }

  /**
   * Получает все доступные кошельки
   */
  private async getAllWallets (): Promise<`0x${string}`[]> {
    return await this.getAllPrivateKeys()
  }

  /**
   * Распределяет модули между кошельками
   */
  private distributeModulesToWallets (wallets: `0x${string}`[]): WalletTask[] {
    const tasks: WalletTask[] = []

    wallets.forEach((privateKey, index) => {
      const moduleIndex = index % this.modules.length
      const assignedModule = this.modules[moduleIndex]!
      const account = privateKeyToAccount(privateKey)

      tasks.push({
        walletIndex: index,
        privateKey,
        walletAddress: account.address,
        assignedModule
      })
    })

    return tasks
  }

  /**
   * Показывает карту распределения модулей
   */
  private showDistributionMap (tasks: WalletTask[]): void {
    console.log('\n🗺️ КАРТА РАСПРЕДЕЛЕНИЯ МОДУЛЕЙ:')
    console.log('-'.repeat(80))

    // Группируем по модулям для удобного отображения
    const moduleGroups = new Map<string, WalletTask[]>()

    tasks.forEach(task => {
      const moduleName = task.assignedModule.name
      if (!moduleGroups.has(moduleName)) {
        moduleGroups.set(moduleName, [])
      }
      moduleGroups.get(moduleName)!.push(task)
    })

    moduleGroups.forEach((tasks, moduleName) => {
      console.log(`\n🎯 ${moduleName}:`)
      tasks.forEach(task => {
        console.log(`   📍 ${task.walletAddress.slice(0, 8)}... (кошелек #${task.walletIndex + 1})`)
      })
    })

    console.log('\n' + '='.repeat(80))
  }

  /**
   * Выполняет задачи с ограничением параллельных потоков
   */
  private async executeTasksWithConcurrency (tasks: WalletTask[], maxConcurrent: number): Promise<void> {
    const results: ThreadResult[] = []
    const startTime = Date.now()

    console.log(`\n🚀 ЗАПУСК ВЫПОЛНЕНИЯ (${tasks.length} задач, максимум ${maxConcurrent} потоков)`)
    console.log('-'.repeat(60))

    // Выполняем задачи батчами
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const batch = tasks.slice(i, i + maxConcurrent)
      console.log(`\n📦 БАТЧ ${Math.floor(i / maxConcurrent) + 1}: кошельки ${i + 1}-${Math.min(i + maxConcurrent, tasks.length)}`)

      const batchPromises = batch.map((task, batchIndex) =>
        this.executeWalletTask(task, i + batchIndex + 1)
      )

      const batchResults = await Promise.allSettled(batchPromises)

      // Обрабатываем результаты батча
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value)
        } else {
          const task = batch[index]!
          results.push({
            threadId: i + index + 1,
            success: false,
            walletAddress: task.walletAddress,
            moduleName: task.assignedModule.name,
            executionTime: 0,
            error: result.reason instanceof Error ? result.reason.message : 'Неизвестная ошибка'
          })
        }
      })

      // Пауза между батчами (кроме последнего)
      if (i + maxConcurrent < tasks.length) {
        console.log('⏳ Пауза 2 секунды между батчами...')
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    const endTime = Date.now()
    const totalTime = (endTime - startTime) / 1000

    // Показываем финальные результаты
    this.showFinalResults(results, totalTime)
  }

  /**
   * Выполняет задачу одного кошелька
   */
  private async executeWalletTask (task: WalletTask, threadId: number): Promise<ThreadResult> {
    const startTime = Date.now()

    try {
      // Специальная обработка для Jumper модуля (rate limit protection)
      if (task.assignedModule.name === 'Jumper') {
        await new Promise(resolve => setTimeout(resolve, 2000)) // 2 секунды задержки
      }

      // Выполняем модуль
      const result = await task.assignedModule.execute(task.privateKey)
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      // Если кошелек пропущен (skipped), это не ошибка
      const isSkipped = result.skipped === true
      const isSuccess = result.success || isSkipped

      return {
        threadId,
        success: isSuccess,
        walletAddress: task.walletAddress,
        moduleName: task.assignedModule.name,
        executionTime,
        transactionHash: result.transactionHash,
        explorerUrl: result.explorerUrl,
        error: isSkipped ? undefined : result.error
      }

    } catch (error) {
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      console.log(`❌ Поток #${threadId} завершен с ошибкой за ${executionTime.toFixed(2)}s`)

      return {
        threadId,
        success: false,
        walletAddress: task.walletAddress,
        moduleName: task.assignedModule.name,
        executionTime,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      }
    }
  }

  /**
   * Показывает финальные результаты выполнения
   */
  private showFinalResults (results: ThreadResult[], totalTime: number): void {
    console.log('\n🏁 ФИНАЛЬНЫЕ РЕЗУЛЬТАТЫ:')
    console.log('='.repeat(60))

    // Считаем успехи и ошибки с учетом специальной логики для Arkada Check-in
    let successCount = 0
    let errorCount = 0

    results.forEach(result => {
      if (result.success) {
        successCount++
      } else {
        // Специальная обработка для Arkada Check-in - не считаем ошибкой если check-in просто недоступен
        if (result.moduleName === 'Arkada Check-in' && result.error?.includes('Check недоступен')) {
          successCount++ // Считаем как успех, так как это не ошибка
        } else {
          errorCount++
        }
      }
    })

    console.log(`✅ Успешно: ${successCount}`)
    console.log(`❌ Ошибок: ${errorCount}`)
    console.log(`⏱️ Общее время: ${totalTime.toFixed(2)} секунд`)

    // Группируем результаты по модулям
    const moduleStats = new Map<string, { success: number, error: number }>()

    results.forEach(result => {
      if (!moduleStats.has(result.moduleName)) {
        moduleStats.set(result.moduleName, { success: 0, error: 0 })
      }

      const stats = moduleStats.get(result.moduleName)!
      if (result.success) {
        stats.success++
      } else {
        stats.error++
      }
    })

    console.log('\n📊 СТАТИСТИКА ПО МОДУЛЯМ:')
    console.log('-'.repeat(60))

    moduleStats.forEach((stats, moduleName) => {
      const total = stats.success + stats.error
      const successRate = ((stats.success / total) * 100).toFixed(1)
      console.log(`🎯 ${moduleName}: ${stats.success}/${total} (${successRate}%)`)
    })

    console.log('\n' + '='.repeat(60))
    console.log('🎉 ВСЕ УНИКАЛЬНЫЕ ДЕЙСТВИЯ ЗАВЕРШЕНЫ!')
    console.log('='.repeat(60))
  }

  /**
   * Перемешивает массив в случайном порядке
   */
  private shuffleArray<T> (array: T[]): T[] {
    const shuffled = [...array]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    return shuffled
  }

  /**
   * Выбирает случайный модуль для выполнения
   */
  private getRandomModule (): Module {
    const randomIndex = Math.floor(Math.random() * this.modules.length)
    const selectedModule = this.modules[randomIndex]!

    return selectedModule
  }

  /**
   * Выбирает уникальный модуль для потока с циклическим перебором
   */
  private getUniqueModule (threadId: number): Module {
    const activeModules = this.getActiveModules()

    // Проверка: должен быть хотя бы 1 активный модуль
    if (activeModules.length === 0) {
      throw new Error('Нет доступных модулей для работы. Все модули исключены.')
    }

    // Циклическое распределение с учетом смещения по итерациям
    const moduleIndex = (this.moduleOffset + threadId - 1) % activeModules.length
    const selectedModule = activeModules[moduleIndex]!

    return selectedModule
  }

  /**
   * Получает случайный приватный ключ
   */
  private async getRandomPrivateKey (): Promise<`0x${string}`> {
    try {
      console.log('🔐 Получаем случайный приватный ключ...')

      const privateKeys = await this.getAllPrivateKeys()

      // Выбираем случайный ключ
      const randomIndex = Math.floor(Math.random() * privateKeys.length)
      const selectedKey = privateKeys[randomIndex]!

      console.log(`✅ Выбран ключ #${randomIndex + 1} из ${privateKeys.length}`)

      return selectedKey
    } catch (error) {
      console.error('❌ Ошибка при получении приватного ключа:', error)
      throw error
    }
  }

  /**
   * Получает все приватные ключи (зашифрованные или открытые) с кэшированием
   */
  private async getAllPrivateKeys (): Promise<`0x${string}`[]> {
    try {
      // 🆕 Если ключи уже загружены, возвращаем из кэша
      if (this.cachedPrivateKeys !== null) {
        return this.cachedPrivateKeys
      }

      const { KeyEncryption } = await import('./key-encryption.js')

      // Работаем с зашифрованными или открытыми ключами
      let privateKeys: string[] = []

      if (KeyEncryption.hasEncryptedKeys()) {
        // Используем зашифрованные ключи
        console.log('🔐 Загружаем зашифрованные ключи...')
        privateKeys = await KeyEncryption.promptPasswordWithRetry()
      } else if (KeyEncryption.hasPlainKeys()) {
        // Используем открытые ключи
        console.log('📄 Загружаем открытые ключи из keys.txt...')
        privateKeys = KeyEncryption.loadPlainKeys()
      } else {
        throw new Error('Не найдены ключи!')
      }

      // 🆕 Кэшируем загруженные ключи
      this.cachedPrivateKeys = privateKeys as `0x${string}`[]
      console.log(`✅ Загружено и закэшировано ${this.cachedPrivateKeys.length} приватных ключей`)

      return this.cachedPrivateKeys
    } catch (error) {
      console.error('❌ Ошибка при получении всех приватных ключей:', error)
      throw error
    }
  }

  /**
   * Показывает результаты итерации
   */
  private showIterationResults (
    threadResults: ThreadResult[],
    successCount: number,
    errorCount: number,
    totalTime: number
  ): void {
    const modulesUsed = threadResults.map(r => r.moduleName)
    logger.iterationStart(modulesUsed)
    logger.iterationResult(successCount, errorCount, totalTime)

    threadResults.forEach(result => {
      logger.threadResult(
        result.threadId,
        result.moduleName,
        result.walletAddress,
        result.success,
        result.executionTime,
        result.transactionHash,
        result.error
      )
    })
  }

  /**
   * 🆕 Проверка цены газа в ETH mainnet
   */
  private async checkGasPrice (gasChecker: GasChecker): Promise<void> {
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
}
