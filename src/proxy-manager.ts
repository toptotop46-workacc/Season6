import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { readFileSync } from 'fs'
import axios from 'axios'

// Интерфейс для конфигурации прокси
export interface ProxyConfig {
  host: string
  port: number
  username: string
  password: string
}

// Интерфейс для HTTP агентов
export interface ProxyAgents {
  httpAgent: import('https-proxy-agent').HttpsProxyAgent<string> | import('socks-proxy-agent').SocksProxyAgent
  httpsAgent: import('https-proxy-agent').HttpsProxyAgent<string> | import('socks-proxy-agent').SocksProxyAgent
}

/**
 * Менеджер прокси для всех модулей
 */
export class ProxyManager {
  private static instance: ProxyManager
  private proxies: ProxyConfig[] = []
  private readonly proxyFile = 'proxy.txt'
  private proxyHealthCache: Map<string, { isHealthy: boolean; lastChecked: number }> = new Map()
  private readonly CACHE_DURATION = 5 * 60 * 1000 // 5 минут кэш
  private usedProxies: Set<string> = new Set()

  private constructor () {
    this.loadProxies()
  }

  /**
   * Получить единственный экземпляр менеджера прокси
   */
  public static getInstance (): ProxyManager {
    if (!ProxyManager.instance) {
      ProxyManager.instance = new ProxyManager()
    }
    return ProxyManager.instance
  }

  /**
   * Загрузить прокси из файла
   */
  private loadProxies (): void {
    try {
      if (!this.fileExists(this.proxyFile)) {
        return
      }

      const content = readFileSync(this.proxyFile, 'utf-8')
      this.proxies = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
          const parts = line.split(':')
          if (parts.length === 4) {
            return {
              host: parts[0]!,
              port: parseInt(parts[1]!),
              username: parts[2]!,
              password: parts[3]!
            }
          }
          return null
        })
        .filter((proxy): proxy is ProxyConfig => proxy !== null)

    } catch {
      this.proxies = []
    }
  }

  /**
   * Проверить существование файла
   */
  private fileExists (path: string): boolean {
    try {
      readFileSync(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Получить случайный прокси
   */
  public getRandomProxy (): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null
    }

    const randomIndex = Math.floor(Math.random() * this.proxies.length)
    return this.proxies[randomIndex]!
  }

  /**
   * Получить прокси, который еще не использовался в этой сессии
   */
  public getUnusedProxy (): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null
    }

    // Если все прокси использованы, сбрасываем список
    if (this.usedProxies.size >= this.proxies.length) {
      this.usedProxies.clear()
    }

    const unusedProxies = this.proxies.filter(proxy => {
      const proxyKey = `${proxy.host}:${proxy.port}`
      return !this.usedProxies.has(proxyKey)
    })

    if (unusedProxies.length === 0) {
      return null
    }

    const randomIndex = Math.floor(Math.random() * unusedProxies.length)
    const selectedProxy = unusedProxies[randomIndex]!

    // Отмечаем прокси как использованный
    const proxyKey = `${selectedProxy.host}:${selectedProxy.port}`
    this.usedProxies.add(proxyKey)

    return selectedProxy
  }

  /**
   * Получить случайный прокси без проверки здоровья (быстрый метод для массовых операций)
   * Использует кэш для фильтрации заведомо нерабочих прокси, но не делает новых проверок
   */
  public getRandomProxyFast (): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null
    }

    // Фильтруем прокси, которые известны как нерабочие (из кэша)
    const potentiallyWorkingProxies = this.proxies.filter(proxy => {
      const proxyKey = `${proxy.host}:${proxy.port}`
      const cached = this.proxyHealthCache.get(proxyKey)

      // Если прокси в кэше и помечен как нерабочий, пропускаем его
      if (cached && !cached.isHealthy) {
        return false
      }

      // Иначе считаем его потенциально рабочим
      return true
    })

    // Если все прокси помечены как нерабочие, используем любой
    const proxiesToChooseFrom = potentiallyWorkingProxies.length > 0
      ? potentiallyWorkingProxies
      : this.proxies

    const randomIndex = Math.floor(Math.random() * proxiesToChooseFrom.length)
    const selectedProxy = proxiesToChooseFrom[randomIndex]!

    // Отмечаем прокси как использованный
    const proxyKey = `${selectedProxy.host}:${selectedProxy.port}`
    this.usedProxies.add(proxyKey)

    return selectedProxy
  }

  /**
   * Получить все доступные прокси
   */
  public getAllProxies (): ProxyConfig[] {
    return [...this.proxies]
  }

  /**
   * Получить количество доступных прокси
   */
  public getProxyCount (): number {
    return this.proxies.length
  }

  /**
   * Проверить, есть ли доступные прокси
   */
  public hasProxies (): boolean {
    return this.proxies.length > 0
  }

  /**
   * Создать HTTP агенты для прокси
   */
  public createProxyAgents (proxy: ProxyConfig): ProxyAgents {
    const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`

    let proxyAgent
    if (proxy.port === 1080 || proxy.port === 1081) {
      // SOCKS прокси
      proxyAgent = new SocksProxyAgent(proxyUrl)
    } else {
      // HTTP/HTTPS прокси
      proxyAgent = new HttpsProxyAgent(proxyUrl)
    }

    return {
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent
    }
  }

  /**
   * Создать fetch опции с прокси
   */
  public createFetchOptions (): RequestInit {
    // Для fetch мы используем node-fetch с прокси или создаем агент
    return {
      headers: {
        'User-Agent': this.getRandomUserAgent()
      }
    }
  }

  /**
   * Получить случайный User-Agent
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
   * Проверить работоспособность прокси
   */
  public async checkProxyHealth (proxy: ProxyConfig): Promise<boolean> {
    const proxyKey = `${proxy.host}:${proxy.port}`
    const now = Date.now()

    // Проверяем кэш
    const cached = this.proxyHealthCache.get(proxyKey)
    if (cached && (now - cached.lastChecked) < this.CACHE_DURATION) {
      return cached.isHealthy
    }

    try {
      const proxyAgents = this.createProxyAgents(proxy)

      // Тестируем несколько URL для более надежной проверки
      const testUrls = [
        'https://httpbin.org/ip',
        'https://api.ipify.org?format=json',
        'https://ipapi.co/json/'
      ]

      for (const testUrl of testUrls) {
        try {
          const testClient = axios.create({
            httpsAgent: proxyAgents.httpsAgent,
            httpAgent: proxyAgents.httpAgent,
            timeout: 10000 // Увеличиваем таймаут до 10 секунд
          })

          const response = await testClient.get(testUrl)

          // Проверяем, что получили валидный ответ
          if (response.status === 200 && response.data) {
            // Кэшируем успешный результат
            this.proxyHealthCache.set(proxyKey, {
              isHealthy: true,
              lastChecked: now
            })
            return true
          }
        } catch {
          // Продолжаем тестирование с другими URL
          continue
        }
      }

      // Если все URL не сработали, кэшируем неудачный результат
      this.proxyHealthCache.set(proxyKey, {
        isHealthy: false,
        lastChecked: now
      })
      return false
    } catch {
      // Кэшируем неудачный результат
      this.proxyHealthCache.set(proxyKey, {
        isHealthy: false,
        lastChecked: now
      })
      return false
    }
  }

  /**
   * Получить рабочий прокси с автоматической ротацией
   */
  public async getWorkingProxy (maxRetries = 5): Promise<ProxyConfig> {
    for (let i = 0; i < maxRetries; i++) {
      // Сначала пробуем неиспользованные прокси
      let proxy = this.getUnusedProxy()

      // Если неиспользованных нет, берем случайный
      if (!proxy) {
        proxy = this.getRandomProxy()
      }

      if (!proxy) {
        continue
      }

      try {
        const isHealthy = await this.checkProxyHealth(proxy)

        if (isHealthy) {
          return proxy
        }
      } catch {
        // Продолжаем поиск
      }

      // Небольшая задержка между попытками
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    throw new Error(`Не удалось найти рабочий прокси после ${maxRetries} попыток`)
  }

  /**
   * Получить информацию о прокси
   */
  public getProxyInfo (): string {
    if (this.proxies.length === 0) {
      return 'Прокси не загружены'
    }
    return `Загружено ${this.proxies.length} прокси`
  }

  /**
   * Очистить кэш и сбросить статистику
   */
  public clearCache (): void {
    this.proxyHealthCache.clear()
    this.usedProxies.clear()
  }

  /**
   * Получить детальную статистику прокси
   */
  public getDetailedStats (): string {
    const totalProxies = this.proxies.length
    const usedProxies = this.usedProxies.size
    const cachedProxies = this.proxyHealthCache.size
    const healthyProxies = Array.from(this.proxyHealthCache.values()).filter(cache => cache.isHealthy).length

    return `📊 Статистика прокси:
- Всего загружено: ${totalProxies}
- Использовано в сессии: ${usedProxies}
- Проверено (в кэше): ${cachedProxies}
- Рабочих (в кэше): ${healthyProxies}`
  }

  /**
   * Массовое тестирование прокси для диагностики
   */
  public async testAllProxies (maxConcurrent = 10): Promise<{
    working: ProxyConfig[]
    broken: ProxyConfig[]
    stats: string
  }> {
    const working: ProxyConfig[] = []
    const broken: ProxyConfig[] = []
    const startTime = Date.now()

    // Разбиваем прокси на батчи для параллельной обработки
    const batches: ProxyConfig[][] = []
    for (let i = 0; i < this.proxies.length; i += maxConcurrent) {
      batches.push(this.proxies.slice(i, i + maxConcurrent))
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex]!

      const promises = batch.map(async (proxy) => {
        try {
          const isHealthy = await this.checkProxyHealth(proxy)
          if (isHealthy) {
            working.push(proxy)
          } else {
            broken.push(proxy)
          }
        } catch {
          broken.push(proxy)
        }
      })

      await Promise.all(promises)

      // Небольшая пауза между батчами
      if (batchIndex < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    const endTime = Date.now()
    const duration = Math.round((endTime - startTime) / 1000)

    const stats = `📊 Результаты тестирования:
- Всего протестировано: ${this.proxies.length}
- Рабочих: ${working.length}
- Нерабочих: ${broken.length}
- Время выполнения: ${duration}с
- Процент рабочих: ${Math.round((working.length / this.proxies.length) * 100)}%`

    return { working, broken, stats }
  }
}
