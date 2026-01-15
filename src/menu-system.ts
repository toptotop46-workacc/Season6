import prompts from 'prompts'
import { privateKeyToAccount } from 'viem/accounts'
import { ParallelExecutor } from './parallel-executor.js'
import { SoneiumCollector } from './modules/collector.js'
import { performWalletTopup } from './wallet-topup.js'
import { GasChecker } from './gas-checker.js'
import { ProxyManager } from './proxy-manager.js'
import axios from 'axios'
import ExcelJS from 'exceljs'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

// Интерфейсы для типизации данных статистики
interface SeasonData {
  address: string
  baseScore: number
  bonusPoints: number
  season: number
  totalScore: number | string
  activityScore: number
  liquidityScore: number
  nftScore: number
  sonyNftScore: number
  isEligible: boolean
  status: string
  badgesCollected: unknown[]
  liquidityContributionPoints: number
  txScore: number
  activityDaysScore: number
  streakScore: number
  createdAt: string
  updatedAt: string
}

interface WalletStatisticsResult {
  address: string
  success: boolean
  status: 'done' | 'not_done' | 'error'
  error?: string
  season6Score: number
  bonusQuests: {
    harkan: string
    surflayer: string
    velodrome: string
    wowmax: string
  }
  pointsCount?: number
}

interface ApiResponseData {
  success: boolean
  data?: SeasonData[]
  error?: string
}

interface BonusDappQuest {
  id: string
  season: number
  name: string
  quests: Array<{
    required: number
    completed: number
    isDone: boolean
  }>
}

interface BonusDappResponseData {
  success: boolean
  data?: BonusDappQuest[]
  error?: string
}

/**
 * Система интерактивного меню для Soneium Automation Bot
 */
export class MenuSystem {
  private parallelExecutor: ParallelExecutor
  // 🆕 Кэш для приватных ключей в меню
  private cachedPrivateKeys: `0x${string}`[] | null = null
  // 🆕 Менеджер прокси для статистики
  private proxyManager: ProxyManager

  constructor (parallelExecutor: ParallelExecutor) {
    this.parallelExecutor = parallelExecutor
    this.proxyManager = ProxyManager.getInstance()
  }

  /**
   * Показывает главное меню
   */
  async showMainMenu (): Promise<void> {
    try {
      const response = await prompts({
        type: 'select',
        name: 'action',
        message: 'Выберите действие:',
        choices: [
          {
            title: '🚀 Запустить работу',
            value: 'start',
            description: 'Запустить автоматизацию с настройкой потоков (1-10, каждый поток - уникальный модуль)'
          },
          {
            title: '💰 Сбор балансов в ETH',
            value: 'collect',
            description: 'Выполнить collector для всех кошельков один раз'
          },
          {
            title: '💎 Пополнение кошельков',
            value: 'topup',
            description: 'Пополнение кошельков ETH в сети Soneium'
          },
          {
            title: '📊 Статистика',
            value: 'stats',
            description: 'Показать статистику по кошелькам и поинтам'
          },
          {
            title: '👋 Выход',
            value: 'exit',
            description: 'Завершить работу программы'
          }
        ],
        initial: 0
      })

      if (response.action === 'start') {
        await this.showThreadSelectionMenu()
      } else if (response.action === 'collect') {
        await this.executeCollectorForAllWallets()
      } else if (response.action === 'topup') {
        await this.showTopupMenu()
      } else if (response.action === 'stats') {
        await this.showStatistics()
      } else if (response.action === 'exit') {
        console.log('\n👋 До свидания!')
        process.exit(0)
      } else {
        console.log('\n❌ Неверный выбор. Попробуйте снова.')
        await this.showMainMenu()
      }
    } catch (error) {
      console.error('\n❌ Ошибка в главном меню:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      process.exit(1)
    }
  }

  /**
   * Показывает меню выбора количества потоков
   */
  private async showThreadSelectionMenu (): Promise<void> {
    try {
      console.log('\n🚀 ЗАПУСК РАБОТЫ')
      console.log('='.repeat(80))
      console.log('Введите количество потоков (1-10):')
      console.log('📝 Если потоков > 1, каждый будет выполнять уникальный модуль (максимум 10)')

      const response = await prompts({
        type: 'number',
        name: 'threadCount',
        message: 'Количество потоков:',
        min: 1,
        max: 10,
        initial: 10,
        validate: (value: number) => {
          if (value < 1 || value > 10) {
            return 'Количество потоков должно быть от 1 до 10'
          }
          return true
        }
      })

      if (response.threadCount) {
        console.log(`\n✅ Выбрано ${response.threadCount} потоков`)

        // 🆕 Запрос максимальной цены газа
        const gasResponse = await prompts({
          type: 'number',
          name: 'maxGasPrice',
          message: 'Максимальная цена газа в ETH mainnet (Gwei):',
          initial: 1,
          min: 0.1,
          max: 100,
          increment: 0.1,
          validate: (value: number) => {
            if (value <= 0) return 'Значение должно быть больше 0'
            if (value > 100) return 'Максимальное значение: 100 Gwei'
            return true
          }
        })

        if (!gasResponse.maxGasPrice) {
          console.log('\n❌ Неверное значение газа. Попробуйте снова.')
          await this.showThreadSelectionMenu()
          return
        }

        // Создаем GasChecker
        const gasChecker = new GasChecker(gasResponse.maxGasPrice)
        console.log(`⛽ Лимит газа установлен: ${gasResponse.maxGasPrice} Gwei`)

        console.log('🚀 Запуск параллельного выполнения...')
        console.log('⚠️  Для остановки нажмите Ctrl+C')
        console.log('='.repeat(80))

        // Запускаем параллельное выполнение с проверкой газа
        await this.parallelExecutor.executeInfiniteLoop(response.threadCount, gasChecker)
      } else {
        console.log('\n❌ Неверный выбор. Попробуйте снова.')
        await this.showThreadSelectionMenu()
      }
    } catch (error) {
      console.error('\n❌ Ошибка в меню выбора потоков:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      process.exit(1)
    }
  }

  /**
   * Выполняет модуль collector для всех кошельков в случайном порядке
   */
  private async executeCollectorForAllWallets (): Promise<void> {
    try {
      console.log('\n💰 СБОР БАЛАНСОВ В ETH')
      console.log('='.repeat(80))

      // 🆕 Запрос максимальной цены газа
      const gasResponse = await prompts({
        type: 'number',
        name: 'maxGasPrice',
        message: 'Максимальная цена газа в ETH mainnet (Gwei):',
        initial: 5,
        min: 0.1,
        max: 100,
        increment: 0.1,
        validate: (value: number) => {
          if (value <= 0) return 'Значение должно быть больше 0'
          if (value > 100) return 'Максимальное значение: 100 Gwei'
          return true
        }
      })

      if (!gasResponse.maxGasPrice) {
        console.log('\n❌ Неверное значение газа. Попробуйте снова.')
        await this.showMainMenu()
        return
      }

      // Создаем GasChecker
      const gasChecker = new GasChecker(gasResponse.maxGasPrice)
      console.log(`⛽ Лимит газа установлен: ${gasResponse.maxGasPrice} Gwei`)

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        console.log('❌ Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      // Перемешиваем массив
      const shuffledKeys = this.shuffleArray(privateKeys)

      console.log(`🎯 Найдено ${shuffledKeys.length} кошельков`)
      console.log('🔄 Начинаем сбор...')
      console.log('⚠️  Для остановки нажмите Ctrl+C')
      console.log('='.repeat(80))

      // Выполняем collector для каждого кошелька
      let successCount = 0
      let errorCount = 0
      const startTime = Date.now()

      for (let i = 0; i < shuffledKeys.length; i++) {
        const privateKey = shuffledKeys[i]!
        const account = privateKeyToAccount(privateKey)

        console.log(`\n📊 КОШЕЛЕК ${i + 1}/${shuffledKeys.length}:`)
        console.log('-'.repeat(50))
        console.log(`📍 Адрес: ${account.address}`)

        try {
          // 🆕 Проверяем цену газа перед выполнением
          console.log('⛽ Проверяем цену газа...')
          await gasChecker.waitForGasPriceToDrop()

          const collector = new SoneiumCollector(privateKey)
          const result = await collector.performCollection()

          if (result.success) {
            successCount++
            console.log(`✅ Успешно собрано: ${result.totalCollected} ETH`)
            console.log(`🪙 Собрано токенов: ${result.collectedTokens.length}`)
            console.log(`🔍 Найдена ликвидность в: ${result.liquidityFound.length} протоколах`)
            console.log(`💸 Выведена ликвидность из: ${result.withdrawnLiquidity.length} протоколов`)
          } else {
            errorCount++
            console.log(`❌ Ошибка: ${result.error}`)
          }
        } catch (error) {
          errorCount++
          console.log(`❌ Критическая ошибка: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        }

        // Пауза между кошельками (кроме последнего)
        if (i < shuffledKeys.length - 1) {
          console.log('⏳ Пауза 3 секунды...')
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showCollectorStatistics(successCount, errorCount, shuffledKeys.length, totalTime)

      // Возвращаемся в главное меню
      console.log('\n⏳ Возврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()

    } catch (error) {
      console.error('\n❌ Ошибка при сборе балансов:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      console.log('\n⏳ Возврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()
    }
  }

  /**
   * Получает все приватные ключи с кэшированием
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
        console.log('🔐 Получаем все приватные ключи из зашифрованного хранилища...')
        privateKeys = await KeyEncryption.promptPasswordWithRetry()
      } else if (KeyEncryption.hasPlainKeys()) {
        // Используем открытые ключи
        console.log('🔐 Получаем все приватные ключи из keys.txt...')
        privateKeys = KeyEncryption.loadPlainKeys()
      } else {
        throw new Error('Не найдены ключи!')
      }

      // 🆕 Кэшируем загруженные ключи
      this.cachedPrivateKeys = privateKeys as `0x${string}`[]
      console.log(`✅ Загружено ${this.cachedPrivateKeys.length} приватных ключей`)

      return this.cachedPrivateKeys
    } catch (error) {
      console.error('❌ Ошибка при получении приватных ключей:', error)
      return []
    }
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
   * Получает данные кошелька через API с retry-логикой и случайными прокси
   */
  // Конфигурация для статистики (как в transaction-checker)
  private readonly STATS_CONFIG = {
    timeout: 10000,            // Timeout в мс
    retryAttempts: 10,         // Попытки повтора
    pointsLimit: 100,          // Лимит поинтов для статуса 'done' (включительно)
    baseUrl: 'https://portal.soneium.org/api'
  }

  /**
   * Безопасно преобразует значение в число
   * Поддерживает как числа, так и строки, которые можно преобразовать в число
   */
  private parseScore (value: unknown): number {
    if (typeof value === 'number') {
      return isNaN(value) ? 0 : value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      return isNaN(parsed) ? 0 : parsed
    }
    return 0
  }

  /**
   * Экспортирует статистику в Excel файл
   */
  private async exportStatisticsToExcel (results: WalletStatisticsResult[]): Promise<string> {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Статистика')

    // Настройка колонок
    worksheet.columns = [
      { header: 'Адрес кошелька', key: 'address', width: 45 },
      { header: 'Сезон 6', key: 'season6', width: 12 },
      { header: 'Harkan', key: 'harkan', width: 15 },
      { header: 'SurfLayer', key: 'surflayer', width: 15 },
      { header: 'Velodrome', key: 'velodrome', width: 15 },
      { header: 'WOWMAX', key: 'wowmax', width: 15 }
    ]

    // Форматирование заголовков
    const headerRow = worksheet.getRow(1)
    headerRow.font = { bold: true, size: 12 }
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' } // Светло-серый фон
    }
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
    headerRow.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    }

    // Добавление данных с цветовой индикацией
    results.forEach((result) => {
      const row = worksheet.addRow({
        address: result.address,
        season6: result.season6Score ?? 0,
        harkan: result.bonusQuests.harkan,
        surflayer: result.bonusQuests.surflayer,
        velodrome: result.bonusQuests.velodrome,
        wowmax: result.bonusQuests.wowmax
      })

      // Цветовая индикация для Season 6
      const season6Cell = row.getCell('season6')
      const season6Score = result.season6Score ?? 0

      if (season6Score >= 80) {
        // Зеленый цвет для поинтов >= 80
        season6Cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF90EE90' } // Светло-зеленый
        }
        season6Cell.font = { bold: true }
      } else if (season6Score >= 76) {
        // Желтый цвет для поинтов 76-79
        season6Cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFFFE0' } // Светло-желтый
        }
        season6Cell.font = { bold: true }
      } else {
        // Красный цвет для поинтов < 76
        season6Cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFB6C1' } // Светло-розовый/красный
        }
      }

      // Цветовая индикация для заданий
      const formatQuestCell = (cell: ExcelJS.Cell, quest: string) => {
        if (quest === 'N/A') {
          // Серый для недоступных
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD3D3D3' }
          }
        } else {
          // Проверяем прогресс (формат "X/Y")
          const match = quest.match(/^(\d+)\/(\d+)$/)
          if (match) {
            const completed = parseInt(match[1]!, 10)
            const required = parseInt(match[2]!, 10)
            if (completed >= required) {
              // Зеленый для выполненных (X >= Y)
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF90EE90' }
              }
              cell.font = { bold: true }
            } else if (completed === 0) {
              // Красный для 0/X
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFB6C1' }
              }
            } else {
              // Желтый для частичного прогресса
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFFFE0' }
              }
            }
          }
        }
        cell.alignment = { horizontal: 'center' }
      }

      formatQuestCell(row.getCell('harkan'), result.bonusQuests.harkan)
      formatQuestCell(row.getCell('surflayer'), result.bonusQuests.surflayer)
      formatQuestCell(row.getCell('velodrome'), result.bonusQuests.velodrome)
      formatQuestCell(row.getCell('wowmax'), result.bonusQuests.wowmax)

      // Выравнивание числовых значений
      season6Cell.alignment = { horizontal: 'center' }
    })

    // Заморозка заголовка при прокрутке
    worksheet.views = [{
      state: 'frozen',
      ySplit: 1 // Заморозить первую строку
    }]

    // Создание папки exports если её нет
    const exportsDir = join(process.cwd(), 'exports')
    if (!existsSync(exportsDir)) {
      mkdirSync(exportsDir, { recursive: true })
    }

    // Генерация имени файла с датой и временем
    const now = new Date()
    const timestamp = now.toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, -5)
      .replace('T', '_')
    const fileName = `statistics_${timestamp}.xlsx`
    const filePath = join(exportsDir, fileName)

    // Сохранение файла
    await workbook.xlsx.writeFile(filePath)

    return filePath
  }

  private async fetchWalletDataWithRetry (address: string): Promise<SeasonData[] | ApiResponseData> {
    let lastError = ''

    for (let attempt = 1; attempt <= this.STATS_CONFIG.retryAttempts; attempt++) {
      try {
        const proxy = this.proxyManager.getRandomProxyFast()
        if (!proxy) {
          throw new Error('Нет доступных прокси')
        }

        const result = await this.getWalletDataViaApi(address, proxy)

        if (result.success && result.data) {
          return result.data
        } else {
          lastError = result.error || 'Неизвестная ошибка'
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      }

      // Задержка между попытками для избежания рейт-лимита
      if (attempt < this.STATS_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    return { success: false, error: `Все ${this.STATS_CONFIG.retryAttempts} попыток неудачны. Последняя ошибка: ${lastError}` }
  }

  // Получение данных из API через прокси (аналогично transaction-checker)
  private async getWalletDataViaApi (address: string, proxy: import('./proxy-manager.js').ProxyConfig): Promise<ApiResponseData> {
    try {
      const axiosInstance = this.createStatsAxiosInstance(proxy)

      // Получаем данные о поинтах
      const response = await axiosInstance.get(`${this.STATS_CONFIG.baseUrl}/profile/calculator?address=${address}`)
      const data = response.data

      // Проверяем, что данные корректные
      if (!data) {
        return {
          success: false,
          error: 'API вернул пустой ответ'
        }
      }

      // Если это массив и он пустой, это нормально (аналогично transaction-checker)
      if (Array.isArray(data) && data.length === 0) {
        return {
          success: true,
          data: []
        }
      }

      return {
        success: true,
        data: data
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        success: false,
        error: errorMessage
      }
    }
  }

  // Получение данных bonus-dapp из API через прокси
  private async getBonusDappDataViaApi (address: string, proxy: import('./proxy-manager.js').ProxyConfig): Promise<BonusDappResponseData> {
    try {
      const axiosInstance = this.createStatsAxiosInstance(proxy)

      // Получаем данные о доп заданиях
      const response = await axiosInstance.get(`${this.STATS_CONFIG.baseUrl}/profile/bonus-dapp?address=${address}`)
      const data = response.data

      // Проверяем, что данные корректные
      if (!data) {
        return {
          success: false,
          error: 'API вернул пустой ответ'
        }
      }

      // Если это массив и он пустой, это нормально
      if (Array.isArray(data) && data.length === 0) {
        return {
          success: true,
          data: []
        }
      }

      return {
        success: true,
        data: data
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        success: false,
        error: errorMessage
      }
    }
  }

  // Получение данных bonus-dapp с retry-логикой
  private async fetchBonusDappDataWithRetry (address: string): Promise<BonusDappQuest[] | BonusDappResponseData> {
    let lastError = ''

    for (let attempt = 1; attempt <= this.STATS_CONFIG.retryAttempts; attempt++) {
      try {
        const proxy = this.proxyManager.getRandomProxyFast()
        if (!proxy) {
          throw new Error('Нет доступных прокси')
        }

        const result = await this.getBonusDappDataViaApi(address, proxy)

        if (result.success && result.data) {
          return result.data
        } else {
          lastError = result.error || 'Неизвестная ошибка'
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      }

      // Задержка между попытками для избежания рейт-лимита
      if (attempt < this.STATS_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    return { success: false, error: `Все ${this.STATS_CONFIG.retryAttempts} попыток неудачны. Последняя ошибка: ${lastError}` }
  }

  // Парсинг заданий сезона 6 из bonus-dapp данных
  private parseBonusQuests (bonusData: BonusDappQuest[]): {
    harkan: string
    surflayer: string
    velodrome: string
    wowmax: string
  } {
    // Фильтруем только задания сезона 6
    const season6Quests = bonusData.filter((item) => item.season === 6)

    // Ищем нужные задания по их id (Season 6)
    const harkanQuest = season6Quests.find((item) => item.id === 'harkan_6')
    const surflayerQuest = season6Quests.find((item) => item.id === 'surflayer_6')
    const velodromeQuest = season6Quests.find((item) => item.id === 'velodrome_6')
    const wowmaxQuest = season6Quests.find((item) => item.id === 'wowmax_6')

    return {
      harkan: harkanQuest ? this.formatQuestProgress(harkanQuest.quests) : 'N/A',
      surflayer: surflayerQuest ? this.formatQuestProgress(surflayerQuest.quests) : 'N/A',
      velodrome: velodromeQuest ? this.formatQuestProgress(velodromeQuest.quests) : 'N/A',
      wowmax: wowmaxQuest ? this.formatQuestProgress(wowmaxQuest.quests) : 'N/A'
    }
  }

  // Форматирование прогресса задания
  private formatQuestProgress (quests: Array<{ required: number, completed: number, isDone: boolean }>): string {
    // Суммируем completed и required из всех квестов
    const totalCompleted = quests.reduce((sum, quest) => sum + quest.completed, 0)
    const totalRequired = quests.reduce((sum, quest) => sum + quest.required, 0)

    // Всегда возвращаем формат "X/Y", даже если все выполнено
    return `${totalCompleted}/${totalRequired}`
  }

  // Создание axios instance с прокси для статистики (аналогично transaction-checker)
  private createStatsAxiosInstance (proxy: import('./proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
    const proxyAgents = this.proxyManager.createProxyAgents(proxy)
    const userAgent = this.getRandomUserAgent()

    return axios.create({
      timeout: this.STATS_CONFIG.timeout,
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
   * Получает случайный User-Agent
   */
  private getRandomUserAgent (): string {
    const userAgents = [
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

    const randomIndex = Math.floor(Math.random() * userAgents.length)
    return userAgents[randomIndex]!
  }

  /**
   * Показывает статистику по кошелькам и поинтам
   */
  private async showStatistics (): Promise<void> {
    try {
      console.log('\n📊 СТАТИСТИКА ПО КОШЕЛЬКАМ')
      console.log('='.repeat(80))
      console.log('🔄 Получаем актуальные данные через API с прокси...')

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        console.log('❌ Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      // Получаем адреса кошельков
      const addresses = privateKeys.map(pk => privateKeyToAccount(pk).address)

      console.log(`📋 Проверяем ${addresses.length} кошельков...`)

      // Счетчик для прогресс-бара
      let completedCount = 0
      const totalCount = addresses.length

      // Функция для обновления прогресс-бара
      const updateProgress = () => {
        const percentage = Math.round((completedCount / totalCount) * 100)
        process.stdout.write(`\r🔄 Проверка кошельков: [${completedCount}/${totalCount}] ${percentage}%`)
      }

      // Обрабатываем кошельки батчами для избежания рейт-лимита
      const BATCH_SIZE = 50 // Размер батча
      const BATCH_DELAY = 100 // Задержка между батчами в мс
      const results: WalletStatisticsResult[] = []

      for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        const batch = addresses.slice(i, i + BATCH_SIZE)

        // Обрабатываем батч параллельно
        const batchResults = await Promise.all(
          batch.map(async (address) => {
            try {
              // Параллельно получаем данные из обоих API
              const [walletData, bonusData] = await Promise.all([
                this.fetchWalletDataWithRetry(address),
                this.fetchBonusDappDataWithRetry(address)
              ])

              // Обработка данных о поинтам (Season 6)
              let season6Score = 0
              let status: 'done' | 'not_done' | 'error' = 'error'

              // Проверяем на ошибку (если вернулся ApiResponseData с ошибкой)
              if (!Array.isArray(walletData) && walletData.error) {
                completedCount++
                updateProgress()
                return {
                  address,
                  success: false,
                  status: 'error' as const,
                  error: walletData.error,
                  season6Score: 0,
                  bonusQuests: {
                    harkan: 'N/A',
                    surflayer: 'N/A',
                    velodrome: 'N/A',
                    wowmax: 'N/A'
                  }
                }
              }

              // Проверяем, что данные - это массив
              if (Array.isArray(walletData) && walletData.length > 0) {
                // Извлекаем данные сезона 6
                const season6Data = walletData.find((item: SeasonData) => item.season === 6)
                season6Score = season6Data ? this.parseScore(season6Data.totalScore) : 0
                status = season6Score >= this.STATS_CONFIG.pointsLimit ? 'done' : 'not_done'
              } else {
                // Если нет данных API, считаем это как 0 поинтов
                status = 'not_done'
              }

              // Обработка данных о доп заданиях
              let bonusQuests = {
                harkan: 'N/A',
                surflayer: 'N/A',
                velodrome: 'N/A',
                wowmax: 'N/A'
              }

              if (Array.isArray(bonusData) && bonusData.length > 0) {
                bonusQuests = this.parseBonusQuests(bonusData)
              } else if (!Array.isArray(bonusData) && bonusData.error) {
                // Ошибка при получении bonus-dapp данных, оставляем N/A
              }

              completedCount++
              updateProgress()

              return {
                address,
                success: true,
                status,
                season6Score,
                bonusQuests,
                pointsCount: season6Score
              }
            } catch (error) {
              completedCount++
              updateProgress()
              return {
                address,
                success: false,
                status: 'error' as const,
                error: error instanceof Error ? error.message : 'Неизвестная ошибка',
                season6Score: 0,
                bonusQuests: {
                  harkan: 'N/A',
                  surflayer: 'N/A',
                  velodrome: 'N/A',
                  wowmax: 'N/A'
                }
              }
            }
          })
        )

        results.push(...batchResults)

        // Задержка между батчами (кроме последнего)
        if (i + BATCH_SIZE < addresses.length) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY))
        }
      }

      // Завершаем прогресс-бар
      console.log('\n')

      // Заголовок таблицы
      console.log('┌─────────────────────────────────────────────────────────┬─────────┬──────────────┬──────────────┬──────────────┬──────────────┐')
      console.log('│ Адрес кошелька                                          │ Сезон 6 │ Harkan       │ SurfLayer    │ Velodrome    │ WOWMAX       │')
      console.log('├─────────────────────────────────────────────────────────┼─────────┼──────────────┼──────────────┼──────────────┼──────────────┤')

      // Данные таблицы
      results.forEach((result) => {
        const address = result.address.length > 50 ? result.address.substring(0, 47) + '...' : result.address

        // Форматируем Season 6 с цветовой индикацией
        let season6 = result.season6Score !== undefined ? result.season6Score.toString().padStart(7) : 'N/A'.padStart(7)
        if (result.season6Score !== undefined) {
          if (result.season6Score >= 80) {
            // Зеленый цвет для поинтов >= 80
            season6 = `\x1b[32m${season6}\x1b[0m`
          } else if (result.season6Score >= 76) {
            // Желтый цвет для поинтов 76-79
            season6 = `\x1b[33m${season6}\x1b[0m`
          } else {
            // Красный цвет для поинтов < 76
            season6 = `\x1b[31m${season6}\x1b[0m`
          }
        }

        // Форматируем задания с цветовой индикацией
        const formatQuest = (quest: string): string => {
          if (quest === 'N/A') {
            return quest.padStart(12)
          } else {
            // Проверяем прогресс (формат "X/Y")
            const match = quest.match(/^(\d+)\/(\d+)$/)
            if (match) {
              const completed = parseInt(match[1]!, 10)
              const required = parseInt(match[2]!, 10)
              if (completed >= required) {
                // Зеленый для выполненных (X >= Y)
                return `\x1b[32m${quest.padStart(12)}\x1b[0m`
              } else if (completed === 0) {
                return `\x1b[31m${quest.padStart(12)}\x1b[0m` // Красный для 0/X
              } else {
                return `\x1b[33m${quest.padStart(12)}\x1b[0m` // Желтый для частичного прогресса
              }
            }
            return quest.padStart(12)
          }
        }

        const harkan = formatQuest(result.bonusQuests.harkan)
        const surflayer = formatQuest(result.bonusQuests.surflayer)
        const velodrome = formatQuest(result.bonusQuests.velodrome)
        const wowmax = formatQuest(result.bonusQuests.wowmax)

        console.log(`│ ${address.padEnd(55)} │ ${season6} │ ${harkan} │ ${surflayer} │ ${velodrome} │ ${wowmax} │`)
      })

      console.log('└─────────────────────────────────────────────────────────┴─────────┴──────────────┴──────────────┴──────────────┴──────────────┘')

      console.log('='.repeat(80))

      // Предложение экспорта в Excel
      const exportResponse = await prompts({
        type: 'confirm',
        name: 'value',
        message: '💾 Экспортировать статистику в Excel файл?',
        initial: true
      })

      if (exportResponse.value) {
        try {
          console.log('\n📝 Создание Excel файла...')
          const filePath = await this.exportStatisticsToExcel(results)
          console.log('\n✅ Статистика успешно экспортирована!')
          console.log(`📁 Путь к файлу: ${filePath}`)
        } catch (error) {
          console.error('\n❌ Ошибка при экспорте в Excel:',
            error instanceof Error ? error.message : 'Неизвестная ошибка')
        }
      }

      // Возвращаемся в главное меню
      await this.showMainMenu()

    } catch (error) {
      console.error('\n❌ Ошибка при получении статистики:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      await this.showMainMenu()
    }
  }

  /**
   * Показывает статистику выполнения collector
   */
  private showCollectorStatistics (successCount: number, errorCount: number, totalCount: number, totalTime: number): void {
    console.log('\n📊 ФИНАЛЬНАЯ СТАТИСТИКА СБОРА')
    console.log('='.repeat(80))
    console.log(`📈 Всего кошельков: ${totalCount}`)
    console.log(`✅ Успешно обработано: ${successCount}`)
    console.log(`❌ Ошибок: ${errorCount}`)
    console.log(`⏱️ Общее время: ${totalTime.toFixed(2)} секунд`)
    console.log(`📊 Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    console.log('='.repeat(80))
    console.log('✅ СБОР ЗАВЕРШЕН!')
    console.log('='.repeat(80))
  }

  /**
   * Показывает меню пополнения кошельков
   */
  private async showTopupMenu (): Promise<void> {
    try {
      console.log('\n💎 ПОПОЛНЕНИЕ КОШЕЛЬКОВ ETH В СЕТИ SONEIUM')
      console.log('='.repeat(80))

      // 1. Минимальная сумма
      const minAmount = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную сумму пополнения (USD):',
        initial: 10,
        min: 1,
        validate: (value: number) => value > 0 ? true : 'Сумма должна быть больше 0'
      })

      // 2. Максимальная сумма
      const maxAmount = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную сумму пополнения (USD):',
        initial: 50,
        min: minAmount.value,
        validate: (value: number) => value >= minAmount.value ? true : 'Максимальная сумма должна быть больше или равна минимальной'
      })

      // 3. Минимальная задержка
      const minDelay = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную задержку между кошельками (минуты):',
        initial: 2,
        min: 1,
        validate: (value: number) => value >= 1 ? true : 'Задержка должна быть не менее 1 минуты'
      })

      // 4. Максимальная задержка
      const maxDelay = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную задержку между кошельками (минуты):',
        initial: 5,
        min: minDelay.value,
        validate: (value: number) => value >= minDelay.value ? true : 'Максимальная задержка должна быть больше или равна минимальной'
      })

      // 5. 🆕 Запрос максимальной цены газа
      const gasResponse = await prompts({
        type: 'number',
        name: 'maxGasPrice',
        message: 'Максимальная цена газа в ETH mainnet (Gwei):',
        initial: 5,
        min: 0.1,
        max: 100,
        increment: 0.1,
        validate: (value: number) => {
          if (value <= 0) return 'Значение должно быть больше 0'
          if (value > 100) return 'Максимальное значение: 100 Gwei'
          return true
        }
      })

      if (!gasResponse.maxGasPrice) {
        console.log('\n❌ Неверное значение газа. Попробуйте снова.')
        await this.showTopupMenu()
        return
      }

      // 6. Подтверждение и запуск
      console.log('\n📊 Настройки пополнения:')
      console.log(`💰 Сумма: $${minAmount.value} - $${maxAmount.value}`)
      console.log(`⏰ Задержки: ${minDelay.value} - ${maxDelay.value} минут`)
      console.log(`⛽ Лимит газа: ${gasResponse.maxGasPrice} Gwei`)
      console.log('='.repeat(80))

      const confirm = await prompts({
        type: 'confirm',
        name: 'value',
        message: 'Запустить пополнение с этими настройками?',
        initial: true
      })

      if (confirm.value) {
        // Создаем GasChecker
        const gasChecker = new GasChecker(gasResponse.maxGasPrice)
        console.log(`⛽ Лимит газа установлен: ${gasResponse.maxGasPrice} Gwei`)

        await this.executeTopupForAllWallets(minAmount.value, maxAmount.value, minDelay.value, maxDelay.value, gasChecker)
      } else {
        console.log('❌ Пополнение отменено')
        await this.showMainMenu()
      }
    } catch (error) {
      console.error('\n❌ Ошибка в меню пополнения:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      await this.showMainMenu()
    }
  }

  /**
   * Выполняет пополнение для всех кошельков
   */
  private async executeTopupForAllWallets (minUSD: number, maxUSD: number, minDelay: number, maxDelay: number, gasChecker?: GasChecker): Promise<void> {
    try {
      console.log('\n🚀 ЗАПУСК ПОПОЛНЕНИЯ КОШЕЛЬКОВ')
      console.log('='.repeat(80))

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        console.log('❌ Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      // Перемешиваем массив
      const shuffledKeys = this.shuffleArray(privateKeys)

      console.log(`🎯 Найдено ${shuffledKeys.length} кошельков`)
      console.log('🔄 Начинаем пополнение...')
      console.log('⚠️  Для остановки нажмите Ctrl+C')
      console.log('='.repeat(80))

      // Выполняем пополнение для каждого кошелька
      let successCount = 0
      let errorCount = 0
      const startTime = Date.now()

      for (let i = 0; i < shuffledKeys.length; i++) {
        const privateKey = shuffledKeys[i]!
        const account = privateKeyToAccount(privateKey)

        console.log(`\n💎 ПОПОЛНЕНИЕ КОШЕЛЬКА ${i + 1}/${shuffledKeys.length}:`)
        console.log('-'.repeat(50))
        console.log(`📍 Адрес: ${account.address}`)

        try {
          // Вызываем реальный модуль пополнения
          const config = {
            minAmountUSD: minUSD,
            maxAmountUSD: maxUSD,
            minDelayMinutes: minDelay,
            maxDelayMinutes: maxDelay
          }

          const result = await performWalletTopup(privateKey, config, gasChecker)

          if (result.success) {
            successCount++
            console.log('✅ Пополнение выполнено успешно!')
            console.log(`💰 Сумма: $${result.amountUSD.toFixed(2)} (${result.amountETH} ETH)`)
            if (result.mexcWithdrawId) {
              console.log(`🏦 MEXC ID: ${result.mexcWithdrawId}`)
            }
            if (result.bridgeTxHash) {
              console.log(`🌉 Bridge TX: ${result.bridgeTxHash}`)
            }
          } else {
            throw new Error(result.error || 'Неизвестная ошибка пополнения')
          }

        } catch (error) {
          errorCount++
          console.log(`❌ Ошибка пополнения: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        }

        // Задержка между кошельками (кроме последнего)
        if (i < shuffledKeys.length - 1) {
          const delayMinutes = Math.random() * (maxDelay - minDelay) + minDelay
          const delayMs = delayMinutes * 60 * 1000

          console.log(`😴 Спим ${delayMinutes.toFixed(2)} минут (${Math.round(delayMs / 1000)} секунд) до следующего кошелька...`)
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showTopupStatistics(successCount, errorCount, shuffledKeys.length, totalTime)

      // Возвращаемся в главное меню
      console.log('\n⏳ Возврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()

    } catch (error) {
      console.error('\n❌ Ошибка при пополнении кошельков:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      console.log('\n⏳ Возврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()
    }
  }

  /**
   * Показывает статистику выполнения пополнения
   */
  private showTopupStatistics (successCount: number, errorCount: number, totalCount: number, totalTime: number): void {
    console.log('\n📊 ФИНАЛЬНАЯ СТАТИСТИКА ПОПОЛНЕНИЯ')
    console.log('='.repeat(80))
    console.log(`📈 Всего кошельков: ${totalCount}`)
    console.log(`✅ Успешно пополнено: ${successCount}`)
    console.log(`❌ Ошибок: ${errorCount}`)
    console.log(`⏱️ Общее время: ${totalTime.toFixed(2)} секунд`)
    console.log(`📊 Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    console.log('='.repeat(80))
    console.log('✅ ПОПОЛНЕНИЕ ЗАВЕРШЕНО!')
    console.log('='.repeat(80))
  }

}
