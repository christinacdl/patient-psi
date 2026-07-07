import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'

type Store = Record<string, any>

type ZMember = {
  score: number
  member: string
}

const DATA_DIR = path.join(process.cwd(), '.local-data')
const DATA_FILE = path.join(DATA_DIR, 'kv.json')

let cache: Store | null = null

function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

async function loadStore(): Promise<Store> {
  if (cache) return cache

  try {
    const raw = await readFile(DATA_FILE, 'utf8')
    cache = JSON.parse(raw)
  } catch {
    cache = {}
  }

  return cache
}

async function saveStore(store: Store) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8')
}

async function runOperation(op: () => void) {
  const store = await loadStore()
  op()
  await saveStore(store)
}

class LocalPipeline {
  private operations: Array<() => Promise<any>> = []

  hgetall<T = any>(key: string) {
    this.operations.push(() => kv.hgetall<T>(key))
    return this
  }

  hmset(key: string, value: Record<string, any>) {
    this.operations.push(() => kv.hmset(key, value))
    return this
  }

  set(key: string, value: any) {
    this.operations.push(() => kv.set(key, value))
    return this
  }

  del(key: string) {
    this.operations.push(() => kv.del(key))
    return this
  }

  zadd(key: string, entry: ZMember) {
    this.operations.push(() => kv.zadd(key, entry))
    return this
  }

  zrem(key: string, member: string) {
    this.operations.push(() => kv.zrem(key, member))
    return this
  }

  async exec() {
    const results = []
    for (const operation of this.operations) {
      results.push(await operation())
    }
    return results
  }
}

export const kv = {
  async get<T = any>(key: string): Promise<T | null> {
    const store = await loadStore()
    return (store[key] ?? null) as T | null
  },

  async set(key: string, value: any) {
    await runOperation(() => {
      cache![key] = value
    })
    return 'OK'
  },

  async del(key: string) {
    let existed = false
    await runOperation(() => {
      existed = Object.prototype.hasOwnProperty.call(cache!, key)
      delete cache![key]
    })
    return existed ? 1 : 0
  },

  async keys(pattern = '*'): Promise<string[]> {
    const store = await loadStore()
    const matcher = globToRegExp(pattern)
    return Object.keys(store).filter(key => matcher.test(key))
  },

  async hgetall<T = any>(key: string): Promise<T | null> {
    const store = await loadStore()
    const value = store[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as T
  },

  async hmset(key: string, value: Record<string, any>) {
    await runOperation(() => {
      const previous = cache![key]
      cache![key] = {
        ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
        ...value
      }
    })
    return 'OK'
  },

  async hget<T = any>(key: string, field: string): Promise<T | null> {
    const value = await kv.hgetall<Record<string, any>>(key)
    return value ? (value[field] as T) : null
  },

  async zadd(key: string, entry: ZMember) {
    await runOperation(() => {
      const existing = Array.isArray(cache![key]) ? cache![key] : []
      const filtered = existing.filter((item: ZMember) => item.member !== entry.member)
      cache![key] = [...filtered, entry]
    })
    return 1
  },

  async zrange(key: string, start: number, stop: number, options?: { rev?: boolean }): Promise<string[]> {
    const store = await loadStore()
    const items = Array.isArray(store[key]) ? [...store[key]] : []
    items.sort((a: ZMember, b: ZMember) => options?.rev ? b.score - a.score : a.score - b.score)
    const normalizedStop = stop === -1 ? items.length : stop + 1
    return items.slice(start, normalizedStop).map((item: ZMember) => item.member)
  },

  async zrem(key: string, member: string) {
    let removed = 0
    await runOperation(() => {
      const existing = Array.isArray(cache![key]) ? cache![key] : []
      const filtered = existing.filter((item: ZMember) => item.member !== member)
      removed = existing.length - filtered.length
      cache![key] = filtered
    })
    return removed
  },

  pipeline() {
    return new LocalPipeline()
  }
}
