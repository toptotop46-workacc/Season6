import { privateKeyToAccount } from 'viem/accounts'
import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { logger } from './logger.js'

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
  [key: string]: unknown
}

// Типы для модулей
interface Module {
  name: string
  description: string
  execute: (privateKey: `0x${string}`) => Promise<ModuleResult>
}

// Список всех доступных модулей
const modules: Record<string, Module> = {
  'aave': {
    name: 'Aave',
    description: 'Управление ликвидностью в протоколе Aave',
    execute: performAaveLiquidity
  },
  'arkada-checkin': {
    name: 'Arkada Check-in',
    description: 'Ежедневный check-in в Arkada',
    execute: performArkadaCheckin
  },
  'lootcoin': {
    name: 'Lootcoin Check-in',
    description: 'Ежедневный check-in в Lootcoin',
    execute: performLootcoinCheckin
  },
  'collector': {
    name: 'Collector',
    description: 'Сбор токенов и проверка ликвидности во всех протоколах',
    execute: performCollection
  },
  'jumper': {
    name: 'Jumper',
    description: 'Свапы токенов через LI.FI',
    execute: performJumperSwap
  },
  'morpho': {
    name: 'Morpho',
    description: 'Управление ликвидностью в протоколе Morpho',
    execute: performMorphoLiquidityManagement
  },
  'sake-finance': {
    name: 'Sake Finance',
    description: 'Операции в протоколе Sake Finance',
    execute: performSakeFinanceOperations
  },
  'stargate': {
    name: 'Stargate',
    description: 'Управление ликвидностью в протоколе Stargate',
    execute: performStargateLiquidity
  },
  'untitled-bank': {
    name: 'Untitled Bank',
    description: 'Управление депозитами в Untitled Bank',
    execute: performDepositManagement
  },
  'revoke': {
    name: 'Revoke',
    description: 'Отзыв всех апрувов для кошелька',
    execute: performRevoke
  },
  'redbutton-noob': {
    name: 'RedButton Noob',
    description: 'Выполнение 1-3 транзакций в режиме noob с задержкой 10-20 секунд',
    execute: performRedButtonNoob
  },
  'harkan': {
    name: 'Harkan',
    description: 'Один спин в Harkan (cyber-roulette)',
    execute: performHarkan
  },
  'velodrome': {
    name: 'Velodrome',
    description: 'Свап ETH → USDC.e (0.1–1% от баланса) через Velodrome',
    execute: performVelodrome
  },
  'wowmax': {
    name: 'WOWMAX',
    description: 'Свап ETH → USDC.e (0.1–1% от баланса) через WOWMAX',
    execute: performWowmax
  }
}

/**
 * Получает случайный приватный ключ из хранилища (зашифрованного или открытого)
 */
async function getRandomPrivateKey (): Promise<`0x${string}`> {
  try {
    console.log('🔐 Получаем случайный приватный ключ...')

    let privateKeys: string[] = []

    // Проверяем, есть ли зашифрованные ключи
    if (KeyEncryption.hasEncryptedKeys()) {
      console.log('🔒 Используем зашифрованные ключи...')
      privateKeys = await KeyEncryption.promptPasswordWithRetry()
    } else if (KeyEncryption.hasPlainKeys()) {
      console.log('📄 Используем открытые ключи из keys.txt...')
      privateKeys = await KeyEncryption.loadPlainKeys()
    } else {
      throw new Error('Не найдено ключей')
    }

    if (privateKeys.length === 0) {
      throw new Error('Не найдено приватных ключей')
    }

    // Выбираем случайный ключ
    const randomIndex = Math.floor(Math.random() * privateKeys.length)
    const selectedKey = privateKeys[randomIndex]!

    console.log(`✅ Выбран ключ #${randomIndex + 1} из ${privateKeys.length}`)

    return selectedKey as `0x${string}`
  } catch (error) {
    console.error('❌ Ошибка при получении приватного ключа:', error)
    throw error
  }
}

/**
 * Выполняет указанный модуль
 */
async function executeModule (moduleName: string): Promise<void> {
  try {
    logger.moduleStart(moduleName)

    // Проверяем существование модуля
    const module = modules[moduleName]
    if (!module) {
      logger.error(`Модуль '${moduleName}' не найден!`)
      logger.info('Доступные модули:')
      Object.keys(modules).forEach(name => {
        logger.info(`  - ${name}`)
      })
      return
    }

    // Получаем случайный приватный ключ
    const privateKey = await getRandomPrivateKey()

    // Создаем account для получения адреса
    const account = privateKeyToAccount(privateKey)

    logger.info(`Адрес кошелька: ${account.address}`)
    logger.info(`Модуль: ${module.name}`)
    logger.info(`Описание: ${module.description}`)

    // Выполняем модуль
    const startTime = Date.now()
    const result = await module.execute(privateKey)
    const endTime = Date.now()
    const executionTime = (endTime - startTime) / 1000

    // Если кошелек пропущен (skipped), это не ошибка
    const isSkipped = result.skipped === true
    const isSuccess = result.success || isSkipped

    logger.moduleEnd(moduleName, isSuccess, executionTime)

    if (isSkipped) {
      logger.info(`Кошелек пропущен: ${result.reason || 'Не указана причина'}`)
    } else if (!result.success) {
      logger.warn(`Модуль завершился с предупреждением: ${result.error || 'Неизвестная проблема'}`)
    }

  } catch (error) {
    logger.moduleEnd(moduleName, false)
    logger.error('Критическая ошибка выполнения модуля', error)
  }
}

/**
 * Показывает список всех доступных модулей
 */
function showAvailableModules (): void {
  console.log('\n📊 ДОСТУПНЫЕ МОДУЛИ:')
  console.log('='.repeat(80))

  Object.entries(modules).forEach(([key, module]) => {
    console.log(`🔹 ${key}`)
    console.log(`   📝 ${module.description}`)
    console.log('')
  })

  console.log(`Всего модулей: ${Object.keys(modules).length}`)
  console.log('='.repeat(80))
}

/**
 * Основная функция для запуска модуля
 */
async function main (): Promise<void> {
  try {
    // Настройка кодировки для корректного отображения кириллицы
    setupEncoding()

    // Получаем имя модуля из аргументов командной строки
    const moduleName = process.argv[2]

    if (!moduleName) {
      console.log('🎯 SONEIUM MODULE RUNNER')
      console.log('='.repeat(80))
      console.log('🤖 Запуск отдельных модулей автоматизации')
      console.log('='.repeat(80))

      showAvailableModules()

      console.log('\n💡 Использование:')
      console.log('  npm run <module-name>')
      console.log('\n📝 Примеры:')
      console.log('  npm run aave')
      console.log('  npm run jumper')
      console.log('  npm run morpho')
      return
    }

    // Проверяем и предлагаем шифрование ключей
    const shouldExit = await KeyEncryption.checkAndOfferEncryption()
    if (shouldExit) {
      console.log('👋 До свидания!')
      return
    }

    // Проверяем наличие ключей (зашифрованных или открытых)
    if (!KeyEncryption.hasEncryptedKeys() && !KeyEncryption.hasPlainKeys()) {
      console.log('❌ Не найдены ключи!')
      console.log('💡 Создайте файл keys.txt с приватными ключами и перезапустите приложение.')
      return
    }

    // Выполняем указанный модуль
    await executeModule(moduleName)

  } catch (error) {
    console.error('💥 КРИТИЧЕСКАЯ ОШИБКА ПРИЛОЖЕНИЯ:', error instanceof Error ? error.message : 'Неизвестная ошибка')
    process.exit(1)
  }
}

// Обработка сигналов завершения
process.on('SIGINT', () => {
  console.log('\n\n👋 Получен сигнал завершения (Ctrl+C)')
  console.log('🛑 Остановка приложения...')
  console.log('✅ До свидания!')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n\n👋 Получен сигнал завершения (SIGTERM)')
  console.log('🛑 Остановка приложения...')
  console.log('✅ До свидания!')
  process.exit(0)
})

// Запуск приложения
main().catch((error) => {
  console.error('💥 Необработанная ошибка:', error)
  process.exit(1)
})
