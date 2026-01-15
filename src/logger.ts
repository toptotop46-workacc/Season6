/**
 * Единая система логирования для Soneium
 * Убирает дублирования и техническое логирование
 */

import { fileLogger } from './file-logger.js'

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

export class Logger {
  private static instance: Logger
  private level: LogLevel = LogLevel.INFO
  private moduleName?: string | undefined

  private constructor (moduleName?: string) {
    this.moduleName = moduleName ?? undefined
  }

  static getInstance (moduleName?: string): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(moduleName)
    }
    return Logger.instance
  }

  setLevel (level: LogLevel): void {
    this.level = level
  }

  private formatMessage (level: string, message: string): string {
    const timestamp = new Date().toLocaleTimeString('ru-RU')
    const module = this.moduleName ? `[${this.moduleName}]` : ''
    return `${timestamp} ${level} ${module} ${message}`
  }

  error (message: string, error?: unknown): void {
    if (this.level >= LogLevel.ERROR) {
      console.error(this.formatMessage('❌', message))
      if (error) {
        // Показываем только краткое сообщение об ошибке без stack trace
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.error(`   Ошибка: ${errorMessage}`)
      }
    }
  }

  warn (message: string): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(this.formatMessage('⚠️', message))
    }
  }

  info (message: string): void {
    if (this.level >= LogLevel.INFO) {
      console.log(this.formatMessage('ℹ️', message))
    }
  }

  success (message: string): void {
    if (this.level >= LogLevel.INFO) {
      console.log(this.formatMessage('✅', message))
    }
  }

  debug (message: string): void {
    if (this.level >= LogLevel.DEBUG) {
      console.log(this.formatMessage('🔍', message))
    }
  }

  // Специальные методы для модулей
  moduleStart (moduleName: string): void {
    console.log('\n' + '='.repeat(60))
    console.log(`🚀 ЗАПУСК МОДУЛЯ: ${moduleName.toUpperCase()}`)
    console.log('='.repeat(60))
  }

  moduleEnd (moduleName: string, success: boolean, executionTime?: number): void {
    console.log('\n' + '='.repeat(60))
    console.log(`${success ? '✅' : '❌'} МОДУЛЬ ${moduleName.toUpperCase()} ${success ? 'ЗАВЕРШЕН УСПЕШНО' : 'ЗАВЕРШЕН С ОШИБКОЙ'}`)
    if (executionTime) {
      console.log(`⏱️ Время выполнения: ${executionTime.toFixed(2)} секунд`)
    }
    console.log('='.repeat(60) + '\n')

    // Записываем результат модуля в файл
    if (executionTime) {
      fileLogger.logModuleResult(moduleName, success, executionTime)
    }
  }

  transaction (hash: string, type: 'sent' | 'confirmed' | 'failed' = 'sent', moduleName?: string, walletAddress?: string): void {
    const status = type === 'sent' ? '📤' : type === 'confirmed' ? '✅' : '❌'
    const action = type === 'sent' ? 'отправлена' : type === 'confirmed' ? 'подтверждена' : 'не удалась'
    const link = `https://soneium.blockscout.com/tx/${hash}`
    console.log(`${status} Транзакция ${action}: ${link}`)

    // Записываем транзакцию в файл только для завершенных операций
    if (type === 'confirmed' || type === 'failed') {
      const success = type === 'confirmed'
      const details = walletAddress ? `${walletAddress} - ${link}` : link
      const module = moduleName || this.moduleName || 'UNKNOWN'
      fileLogger.logTransaction(hash, success, module, details)
    }
  }

  balance (token: string, amount: string, address?: string): void {
    const addr = address ? ` (${address.slice(0, 8)}...)` : ''
    console.log(`💰 ${token} баланс${addr}: ${amount}`)
  }

  operation (operation: string, status: 'start' | 'success' | 'error', details?: string): void {
    const icon = status === 'start' ? '🔄' : status === 'success' ? '✅' : '❌'
    const action = status === 'start' ? 'Начинаем' : status === 'success' ? 'Завершено' : 'Ошибка'
    console.log(`${icon} ${action} ${operation}${details ? `: ${details}` : ''}`)
  }

  // Методы для результатов итераций
  iterationStart (modules: string[]): void {
    console.log('\n📊 НАЧАЛО ИТЕРАЦИИ')
    console.log('-'.repeat(40))
    console.log(`🎯 Модули: ${modules.join(', ')}`)
  }

  iterationResult (successCount: number, errorCount: number, totalTime: number): void {
    console.log('\n📊 РЕЗУЛЬТАТЫ ИТЕРАЦИИ:')
    console.log('-'.repeat(40))
    console.log(`✅ Успешно: ${successCount}`)
    console.log(`❌ Ошибок: ${errorCount}`)
    console.log(`⏱️ Время: ${totalTime.toFixed(2)}с`)
  }

  threadResult (threadId: number, moduleName: string, walletAddress: string, success: boolean, executionTime: number, transactionHash?: string, error?: string): void {
    const status = success ? '✅' : '⚠️'
    const time = executionTime.toFixed(2)
    const addr = walletAddress.slice(0, 8) + '...'

    console.log(`${status} Поток #${threadId}: ${moduleName} (${addr}) - ${time}с`)

    if (success && transactionHash) {
      console.log(`   🔗 TX: ${transactionHash}`)
    }
    if (error) {
      // Специальная обработка для Arkada Check-in
      if (moduleName === 'Arkada Check-in' && error.includes('Check недоступен')) {
        console.log(`   ⏰ ${error}`)
      } else {
        console.log(`   ⚠️ ${error}`)
      }
    }

    // Записываем результат в файл
    const details = `Поток #${threadId} | ${walletAddress} | Время: ${time}с${transactionHash ? ` | TX: ${transactionHash}` : ''}${error ? ` | Ошибка: ${error}` : ''}`

    if (success) {
      fileLogger.logSuccess(moduleName, 'THREAD_SUCCESS', details)
    } else {
      fileLogger.logFailed(moduleName, 'THREAD_FAILED', details)
    }
  }

  // Методы для записи в файлы
  logToFile (success: boolean, module: string, operation: string, details: string): void {
    if (success) {
      fileLogger.logSuccess(module, operation, details)
    } else {
      fileLogger.logFailed(module, operation, details)
    }
  }

  logTransactionToFile (hash: string, success: boolean, module: string, details: string): void {
    fileLogger.logTransaction(hash, success, module, details)
  }

  logModuleToFile (moduleName: string, success: boolean, executionTime: number, details?: string): void {
    fileLogger.logModuleResult(moduleName, success, executionTime, details)
  }

  logTopupToFile (success: boolean, walletAddress: string, amount: string, strategy: string, details?: string): void {
    fileLogger.logWalletTopup(success, walletAddress, amount, strategy, details)
  }

  logBridgeToFile (success: boolean, fromNetwork: string, toNetwork: string, amount: string, txHash?: string, error?: string): void {
    fileLogger.logBridge(success, fromNetwork, toNetwork, amount, txHash, error)
  }

  // Специальное логирование для ежедневных операций
  dailyCheck (address: string, hasTransacted: boolean, lastDate?: string): void {
    if (hasTransacted) {
      console.log(`⏭️  ${address.slice(0, 8)}... already transacted today (${lastDate})`)
    } else {
      console.log(`🎯 ${address.slice(0, 8)}... needs daily streak`)
    }
  }
}

// Экспорт для удобства
export const logger = Logger.getInstance()
