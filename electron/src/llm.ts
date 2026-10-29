import { LLMSettings } from '../../shared/types'

/**
 * 脱敏：把密钥痕迹从任意文本里抹掉。
 * 上游接口的错误响应体有时会回显请求头，而这些错误会被抛到界面上显示，
 * 所以统一在抛出前过一遍。
 */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('***REDACTED***')
  }
  return out
    .replace(/\b(sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}/gi, '$1-***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]{8,}/gi, '$1 ***')
    .replace(/\b(AIza|LTAI|AKID|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, '$1***')
}

export function stripCodeFence(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  return t.trim()
}

/** 从 LLM 输出中提取 JSON（容忍markdown围栏与前后杂文） */
export function extractJsonArray(text: string): unknown[] | null {
  const t = stripCodeFence(text)
  try {
    const parsed = JSON.parse(t)
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.clips)) return parsed.clips
  } catch {
    /* fallthrough */
  }
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(t.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    } catch {
      /* ignore */
    }
  }
  return null
}

export class LlmClient {
  constructor(private settings: LLMSettings) {}

  private endpoint(): string {
    const base = this.settings.baseUrl.replace(/\/+$/, '')
    if (base.endsWith('/chat/completions')) return base
    if (base.endsWith('/v1')) return `${base}/chat/completions`
    return `${base}/v1/chat/completions`
  }

  async chat(systemPrompt: string, userPayload: unknown, retries = 3): Promise<string> {
    let lastErr: Error | null = null
    const secrets = [this.settings.apiKey]
    for (let i = 0; i < retries; i++) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 180000)
        const res = await fetch(this.endpoint(), {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.settings.apiKey}`
          },
          body: JSON.stringify({
            model: this.settings.model,
            temperature: this.settings.temperature,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: JSON.stringify(userPayload) }
            ]
          })
        })
        clearTimeout(timer)
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`LLM API ${res.status}: ${redactSecrets(body.slice(0, 300), secrets)}`)
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[]
        }
        const content = data.choices?.[0]?.message?.content
        if (!content) throw new Error('LLM 返回内容为空')
        return content
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        lastErr = new Error(redactSecrets(raw, secrets))
        if (i < retries - 1) {
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
        }
      }
    }
    throw lastErr || new Error('LLM 调用失败')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const reply = await this.chat('请直接返回JSON对象 {"ok": true}', { ping: 1 }, 1)
      return { ok: true, message: `连接成功，模型回复: ${reply.slice(0, 50)}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}
