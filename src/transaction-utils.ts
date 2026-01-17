import type { PublicClient, WalletClient } from 'viem'
import { logger } from './logger.js'

/**
 * Утилиты для безопасной отправки транзакций с проверкой nonce
 */

export interface TransactionSafetyCheck {
  canProceed: boolean
  pendingTransactions: string[]
  currentNonce: number
  recommendedNonce: number
  warnings: string[]
}

/**
 * Проверяет безопасность отправки транзакции
 */
export async function checkTransactionSafety (
  publicClient: PublicClient,
  walletClient: WalletClient,
  accountAddress: `0x${string}`
): Promise<TransactionSafetyCheck> {
  const warnings: string[] = []
  const pendingTransactions: string[] = []

  try {
    // Получаем текущий nonce
    const currentNonce = await publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: 'latest'
    })

    // Получаем pending nonce
    const pendingNonce = await publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: 'pending'
    })

    // Рекомендуемый nonce должен быть pendingNonce (следующий доступный)
    const recommendedNonce = pendingNonce

    // Проверяем, есть ли pending транзакции
    if (pendingNonce > currentNonce) {
      warnings.push(`⚠️ Обнаружено ${pendingNonce - currentNonce} pending транзакций`)
    }

    // Проверяем, можно ли безопасно отправить транзакцию
    // Если есть pending транзакции, лучше подождать
    const canProceed = pendingNonce === currentNonce

    if (!canProceed) {
      warnings.push('🚫 Нельзя отправить транзакцию - есть pending операции')
    }

    return {
      canProceed,
      pendingTransactions,
      currentNonce: Number(currentNonce),
      recommendedNonce: Number(recommendedNonce),
      warnings
    }

  } catch (error) {
    logger.error('Ошибка при проверке безопасности транзакции', error)
    return {
      canProceed: false,
      pendingTransactions: [],
      currentNonce: 0,
      recommendedNonce: 0,
      warnings: ['❌ Ошибка при проверке nonce']
    }
  }
}

/**
 * Ждет завершения всех pending транзакций
 */
export async function waitForPendingTransactions (
  publicClient: PublicClient,
  accountAddress: `0x${string}`,
  maxWaitTime: number = 60000 // 60 секунд
): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const currentNonce = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'latest'
      })

      const pendingNonce = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'pending'
      })

      if (pendingNonce === currentNonce) {
        logger.success('Все pending транзакции завершены')
        return true
      }

      logger.info(`Ожидаем завершения pending транзакций... (${pendingNonce - currentNonce} осталось)`)
      await new Promise(resolve => setTimeout(resolve, 15000)) // Ждем 5 секунд

    } catch (error) {
      logger.error('Ошибка при ожидании pending транзакций', error)
      return false
    }
  }

  logger.warn('Таймаут ожидания pending транзакций')
  return false
}

/**
 * Безопасная отправка транзакции с проверкой nonce
 */
export async function safeSendTransaction (
  publicClient: PublicClient,
  walletClient: WalletClient,
  accountAddress: `0x${string}`,
  transactionParams: Record<string, unknown>,
  maxRetries: number = 3
): Promise<{ hash: `0x${string}`; success: boolean; error?: string }> {

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Убираем техническую информацию о попытках

      // Проверяем безопасность
      const safetyCheck = await checkTransactionSafety(publicClient, walletClient, accountAddress)

      if (!safetyCheck.canProceed) {
        logger.info('Ожидаем завершения pending транзакций...')
        const waited = await waitForPendingTransactions(publicClient, accountAddress)

        if (!waited) {
          if (attempt === maxRetries) {
            return {
              hash: '0x' as `0x${string}`,
              success: false,
              error: 'Не удалось дождаться завершения pending транзакций'
            }
          }
          continue
        }
      }

      // Логируем предупреждения
      if (safetyCheck.warnings.length > 0) {
        safetyCheck.warnings.forEach(warning => logger.warn(warning))
      }

      // Дополнительная проверка nonce перед отправкой
      const finalNonceCheck = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'pending'
      })

      if (finalNonceCheck !== safetyCheck.recommendedNonce) {
        logger.warn(`Nonce изменился с ${safetyCheck.recommendedNonce} на ${finalNonceCheck}, обновляем...`)
        safetyCheck.recommendedNonce = finalNonceCheck
      }

      // Отправляем транзакцию
      const hash = await walletClient.sendTransaction({
        ...transactionParams,
        nonce: safetyCheck.recommendedNonce
      } as Parameters<typeof walletClient.sendTransaction>[0])

      // Не логируем здесь - это будет сделано в модулях через logger.transaction()
      // Убираем дублирование логов
      return { hash, success: true }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      // Если это ошибка nonce, не логируем полную ошибку
      if (errorMessage.includes('nonce') || errorMessage.includes('replacement')) {
        logger.warn('Ошибка nonce, ждем 30 секунд...')
        await new Promise(resolve => setTimeout(resolve, 30000))
        continue
      } else {
        // Для других ошибок логируем полную информацию
        logger.error(`Ошибка попытки ${attempt}: ${errorMessage}`)
      }

      if (attempt === maxRetries) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: errorMessage
        }
      }

      // Ждем перед следующей попыткой
      await new Promise(resolve => setTimeout(resolve, 15000))
    }
  }

  return {
    hash: '0x' as `0x${string}`,
    success: false,
    error: 'Исчерпаны все попытки'
  }
}

/**
 * Безопасная отправка writeContract с проверкой nonce
 */
export async function safeWriteContract (
  publicClient: PublicClient,
  walletClient: WalletClient,
  accountAddress: `0x${string}`,
  contractParams: Record<string, unknown>,
  maxRetries: number = 3
): Promise<{ hash: `0x${string}`; success: boolean; error?: string }> {

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Убираем техническую информацию о попытках

      // Проверяем безопасность
      const safetyCheck = await checkTransactionSafety(publicClient, walletClient, accountAddress)

      if (!safetyCheck.canProceed) {
        logger.info('Ожидаем завершения pending транзакций...')
        const waited = await waitForPendingTransactions(publicClient, accountAddress)

        if (!waited) {
          if (attempt === maxRetries) {
            return {
              hash: '0x' as `0x${string}`,
              success: false,
              error: 'Не удалось дождаться завершения pending транзакций'
            }
          }
          continue
        }
      }

      // Логируем предупреждения
      if (safetyCheck.warnings.length > 0) {
        safetyCheck.warnings.forEach(warning => logger.warn(warning))
      }

      // Дополнительная проверка nonce перед отправкой
      const finalNonceCheck = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'pending'
      })

      if (finalNonceCheck !== safetyCheck.recommendedNonce) {
        logger.warn(`Nonce изменился с ${safetyCheck.recommendedNonce} на ${finalNonceCheck}, обновляем...`)
        safetyCheck.recommendedNonce = finalNonceCheck
      }

      // Отправляем контрактную транзакцию
      const hash = await walletClient.writeContract({
        ...contractParams,
        nonce: safetyCheck.recommendedNonce
      } as Parameters<typeof walletClient.writeContract>[0])

      // Не логируем здесь - это будет сделано в модулях через logger.transaction()
      // Убираем дублирование логов
      return { hash, success: true }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'

      // Пытаемся извлечь hash из ошибки, если транзакция была отправлена
      // Viem иногда возвращает hash в ошибке, если транзакция была отправлена
      let extractedHash: `0x${string}` | undefined

      if (error && typeof error === 'object') {
        // Проверяем различные возможные места, где может быть hash
        const errorObj = error as Record<string, unknown>
        if (errorObj['hash'] && typeof errorObj['hash'] === 'string' && errorObj['hash'].startsWith('0x')) {
          extractedHash = errorObj['hash'] as `0x${string}`
        } else if (errorObj['data'] && typeof errorObj['data'] === 'object') {
          const data = errorObj['data'] as Record<string, unknown>
          if (data['hash'] && typeof data['hash'] === 'string' && data['hash'].startsWith('0x')) {
            extractedHash = data['hash'] as `0x${string}`
          }
        } else if (errorObj['cause'] && typeof errorObj['cause'] === 'object') {
          const cause = errorObj['cause'] as Record<string, unknown>
          if (cause['hash'] && typeof cause['hash'] === 'string' && cause['hash'].startsWith('0x')) {
            extractedHash = cause['hash'] as `0x${string}`
          }
        }

        // Также проверяем сообщение об ошибке на наличие hash
        if (!extractedHash && errorMessage) {
          const hashMatch = errorMessage.match(/0x[a-fA-F0-9]{64}/)
          if (hashMatch) {
            extractedHash = hashMatch[0] as `0x${string}`
          }
        }
      }

      // Если нашли hash в ошибке, значит транзакция была отправлена
      if (extractedHash) {
        logger.info(`Транзакция была отправлена, hash извлечен из ошибки: ${extractedHash}`)
        return { hash: extractedHash, success: true }
      }

      // Если это ошибка nonce, не логируем полную ошибку
      if (errorMessage.includes('nonce') || errorMessage.includes('replacement')) {
        logger.warn('Ошибка nonce, ждем 30 секунд...')
        await new Promise(resolve => setTimeout(resolve, 30000))
        continue
      } else {
        // Для других ошибок логируем полную информацию
        logger.error(`Ошибка попытки ${attempt}: ${errorMessage}`)
      }

      if (attempt === maxRetries) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: errorMessage
        }
      }

      // Ждем перед следующей попыткой
      await new Promise(resolve => setTimeout(resolve, 15000))
    }
  }

  return {
    hash: '0x' as `0x${string}`,
    success: false,
    error: 'Исчерпаны все попытки'
  }
}
