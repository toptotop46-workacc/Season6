import * as crypto from 'crypto'
import * as fs from 'fs'
import * as readline from 'readline'

export class KeyEncryption {
  private static readonly ALGORITHM = 'aes-256-cbc'
  private static readonly ENCRYPTED_FILE = 'keys.encrypted'
  private static readonly SALT_FILE = 'keys.salt'

  // Деривация ключа из пароля
  private static deriveKey (password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
  }

  // Шифрование ключей
  static encryptKeys (privateKeys: string[], password: string): void {
    const salt = crypto.randomBytes(32)
    const key = this.deriveKey(password, salt)
    const iv = crypto.randomBytes(16)

    const keysData = privateKeys.join('\n')
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv)

    let encrypted = cipher.update(keysData, 'utf8', 'hex')
    encrypted += cipher.final('hex')

    const encryptedData = iv.toString('hex') + ':' + encrypted

    fs.writeFileSync(this.ENCRYPTED_FILE, encryptedData)
    fs.writeFileSync(this.SALT_FILE, salt.toString('hex'))
  }

  // Расшифровка ключей с правильной обработкой ошибок
  static decryptKeys (password: string): string[] {
    if (!fs.existsSync(this.ENCRYPTED_FILE) || !fs.existsSync(this.SALT_FILE)) {
      throw new Error('Зашифрованные файлы не найдены')
    }

    try {
      const saltHex = fs.readFileSync(this.SALT_FILE, 'utf8')
      const salt = Buffer.from(saltHex, 'hex')
      const key = this.deriveKey(password, salt)

      const encryptedData = fs.readFileSync(this.ENCRYPTED_FILE, 'utf8')
      const [ivHex, encrypted] = encryptedData.split(':')

      if (!ivHex || !encrypted) {
        throw new Error('invalid_format')
      }

      const iv = Buffer.from(ivHex, 'hex')

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')

      return decrypted.split('\n').filter(key => key.trim())
    } catch {
      // Возвращаем понятную ошибку без технических деталей
      throw new Error('WRONG_PASSWORD')
    }
  }

  // Проверка наличия зашифрованных ключей
  static hasEncryptedKeys (): boolean {
    return fs.existsSync(this.ENCRYPTED_FILE) && fs.existsSync(this.SALT_FILE)
  }

  // Проверка наличия открытых ключей
  static hasPlainKeys (): boolean {
    return fs.existsSync('keys.txt')
  }

  // Загрузка открытых ключей из файла
  static loadPlainKeys (): string[] {
    if (!this.hasPlainKeys()) {
      throw new Error('Файл keys.txt не найден')
    }

    const content = fs.readFileSync('keys.txt', 'utf8')
    const lines = content.split('\n')
    const privateKeys: string[] = []

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        let privateKey = trimmedLine
        if (!privateKey.startsWith('0x')) {
          privateKey = '0x' + privateKey
        }
        if (/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
          privateKeys.push(privateKey)
        }
      }
    }

    if (privateKeys.length === 0) {
      throw new Error('Не найдено валидных приватных ключей в файле keys.txt')
    }

    return privateKeys
  }

  // Безопасный запрос пароля с повторными попытками
  static async promptPasswordWithRetry (): Promise<string[]> {
    while (true) {
      try {
        const password = await this.promptPassword('Введите пароль для расшифровки: ')
        const keys = this.decryptKeys(password)
        return keys
      } catch (error) {
        if (error instanceof Error && error.message === 'WRONG_PASSWORD') {
          console.log('❌ Неверный пароль. Повторите попытку.')
          continue
        }
        throw error
      }
    }
  }

  // Проверка и предложение шифрования при старте
  static async checkAndOfferEncryption (): Promise<boolean> {
    if (this.hasPlainKeys() && !this.hasEncryptedKeys()) {
      console.log('\n🔐 Обнаружен файл keys.txt с открытыми приватными ключами')
      console.log('⚠️  Рекомендуется зашифровать ключи для безопасности')

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      const answer = await new Promise<string>((resolve) => {
        rl.question('Хотите зашифровать ключи сейчас? (y/n): ', (answer: string) => {
          rl.close()
          resolve(answer.toLowerCase())
        })
      })

      if (answer === 'y' || answer === 'yes') {
        try {
          await this.migratePlainKeys()
          console.log('\n✅ Шифрование завершено!')
          console.log('🔄 Перезапустите приложение: npm start')
          console.log('🗑️  Удалите файл keys.txt вручную для безопасности')
          return true
        } catch (error) {
          console.error('❌ Ошибка при шифровании:', error instanceof Error ? error.message : 'Неизвестная ошибка')
          process.exit(1)
        }
      }
    }
    return false
  }

  // Безопасный ввод пароля (скрытый) с поддержкой Ctrl+C
  static async promptPassword (message: string = 'Введите пароль: '): Promise<string> {
    return new Promise<string>((resolve) => {
      // Флаг для отслеживания завершения
      let isResolved = false
      let password = ''

      // Обработчик сигнала SIGINT (Ctrl+C)
      const sigintHandler = (): void => {
        if (!isResolved) {
          isResolved = true
          // Восстанавливаем нормальный режим stdin
          if (process.stdin.isRaw) {
            process.stdin.setRawMode(false)
          }
          process.stdin.pause()
          process.stdout.write('\n\n')
          console.log('👋 Получен сигнал завершения (Ctrl+C)')
          console.log('🛑 Остановка приложения...')
          // Удаляем все обработчики перед выходом
          cleanup()
          process.exit(0)
        }
      }

      // Обработчик сигнала SIGTERM
      const sigtermHandler = (): void => {
        if (!isResolved) {
          isResolved = true
          if (process.stdin.isRaw) {
            process.stdin.setRawMode(false)
          }
          process.stdin.pause()
          process.stdout.write('\n\n')
          console.log('👋 Получен сигнал завершения (SIGTERM)')
          console.log('🛑 Остановка приложения...')
          cleanup()
          process.exit(0)
        }
      }

      // Обработчик нажатий клавиш (объявляем до cleanup)
      const keyHandler = (char: string): void => {
        if (isResolved) return

        // Ctrl+C (код 3)
        if (char === '\u0003' || char === '\x03' || (char.length === 1 && char.charCodeAt(0) === 3)) {
          sigintHandler()
          return
        }

        // Enter
        if (char === '\r' || char === '\n' || char === '\u000d' || char === '\u000a') {
          process.stdout.write('\n')
          cleanup()

          if (!isResolved) {
            isResolved = true
            resolve(password)
          }
          return
        }

        // Backspace или Delete
        if (char === '\u007f' || char === '\b' || char === '\x7f' || char === '\u0008') {
          if (password.length > 0) {
            password = password.slice(0, -1)
            process.stdout.write('\b \b')
          }
          return
        }

        // Обычные печатные символы (ASCII 32-126)
        if (char.length === 1) {
          const code = char.charCodeAt(0)
          if (code >= 32 && code < 127) {
            password += char
            process.stdout.write('*')
          }
        }
      }

      // Функция очистки обработчиков
      const cleanup = (): void => {
        process.removeListener('SIGINT', sigintHandler)
        process.removeListener('SIGTERM', sigtermHandler)
        process.stdin.removeListener('data', keyHandler)
        if (process.stdin.isRaw) {
          process.stdin.setRawMode(false)
        }
      }

      // Устанавливаем обработчики сигналов ПЕРЕД началом ввода
      // Используем prependListener чтобы наш обработчик сработал первым
      process.prependListener('SIGINT', sigintHandler)
      process.prependListener('SIGTERM', sigtermHandler)

      // Включаем raw mode для скрытого ввода
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')

      process.stdout.write(message)

      process.stdin.on('data', keyHandler)
    })
  }

  // Ввод пароля с подтверждением
  static async promptPasswordWithConfirmation (): Promise<string> {
    const password = await this.promptPassword('Введите пароль для шифрования: ')
    const confirmPassword = await this.promptPassword('Подтвердите пароль: ')

    if (password !== confirmPassword) {
      throw new Error('Пароли не совпадают')
    }

    if (password.length < 6) {
      throw new Error('Пароль должен содержать минимум 6 символов')
    }

    return password
  }

  // Миграция открытых ключей в зашифрованные
  static async migratePlainKeys (): Promise<void> {
    if (!this.hasPlainKeys()) {
      throw new Error('Файл keys.txt не найден')
    }

    const content = fs.readFileSync('keys.txt', 'utf8')
    const lines = content.split('\n')
    const privateKeys: string[] = []

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        let privateKey = trimmedLine
        if (!privateKey.startsWith('0x')) {
          privateKey = '0x' + privateKey
        }
        if (/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
          privateKeys.push(privateKey)
        }
      }
    }

    if (privateKeys.length === 0) {
      throw new Error('Не найдено валидных приватных ключей в файле keys.txt')
    }

    const password = await this.promptPasswordWithConfirmation()
    this.encryptKeys(privateKeys, password)

    console.log(`✅ Успешно зашифровано ${privateKeys.length} приватных ключей`)
  }
}
