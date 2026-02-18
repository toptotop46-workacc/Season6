import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { TransactionChecker } from './modules/transaction-checker.js'
import { MenuSystem } from './menu-system.js'
import { ParallelExecutor } from './parallel-executor.js'
import { Banner } from './banner.js'

// Глобальные экземпляры систем
let transactionChecker: TransactionChecker | null = null

/**
 * Основная функция приложения
 */
async function main (): Promise<void> {
  try {
    // Настройка кодировки для корректного отображения кириллицы
    setupEncoding()

    // Показываем заставку
    Banner.show()

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

    // Инициализируем checker для индивидуальных проверок
    transactionChecker = new TransactionChecker()

    // Создаем экземпляр параллельного исполнителя
    const parallelExecutor = new ParallelExecutor(transactionChecker)

    // Создаем экземпляр системы меню
    const menuSystem = new MenuSystem(parallelExecutor)

    // Запускаем главное меню
    await menuSystem.showMainMenu()

  } catch (error) {
    if (error instanceof Error && error.message === 'WRONG_PASSWORD') {
      console.log('👋 До свидания!')
      process.exit(0)
    } else {
      console.error('💥 КРИТИЧЕСКАЯ ОШИБКА ПРИЛОЖЕНИЯ:', error instanceof Error ? error.message : 'Неизвестная ошибка')
      process.exit(1)
    }
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
