/**
 * 极简 TOML 读取/写入工具，只覆盖 MaiBot 插件 config.toml 实际用到的子集：
 * 注释、`[section]`、`[section.sub]`、字符串（单/双引号）、布尔、整数、浮点、内联数组。
 *
 * 刻意不做成通用 TOML 实现：解析失败必须带行号抛错，让调用方看到真实问题，
 * 而不是猜一个默认值继续跑。
 */

const SECTION_RE = /^\[([^\]]+)\]\s*(?:#.*)?$/
const KEY_RE = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/

/**
 * 解析 TOML 文本。
 *
 * @param {string} text config.toml 内容。
 * @returns {{ sections: Map<string, Map<string, unknown>>, duplicatedSections: string[] }} 解析结果。
 */
export function parseToml(text) {
  const sections = new Map()
  const duplicatedSections = []
  let current = ''
  sections.set('', new Map())

  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    const withoutComment = stripComment(lines[index]).trim()
    if (!withoutComment) continue

    const sectionMatch = SECTION_RE.exec(withoutComment)
    if (sectionMatch) {
      current = sectionMatch[1].trim()
      if (sections.has(current)) duplicatedSections.push(current)
      else sections.set(current, new Map())
      continue
    }

    const keyMatch = KEY_RE.exec(withoutComment)
    if (!keyMatch) throw new Error(`第 ${lineNo} 行无法解析：${lines[index].trim()}`)

    const key = keyMatch[1]
    const value = parseValue(keyMatch[2], lineNo)
    const table = sections.get(current)
    if (table.has(key)) throw new Error(`第 ${lineNo} 行重复定义键 ${current ? `[${current}].` : ''}${key}`)
    table.set(key, value)
  }

  return { sections, duplicatedSections }
}

/**
 * 读取 `[section].key`。
 *
 * @param {{ sections: Map<string, Map<string, unknown>> }} parsed 解析结果。
 * @param {string} section 段名。
 * @param {string} key 键名。
 * @returns {unknown} 值；不存在返回 undefined。
 */
export function getValue(parsed, section, key) {
  return parsed.sections.get(section)?.get(key)
}

/**
 * 列出所有段名（不含根段）。
 *
 * @param {{ sections: Map<string, Map<string, unknown>> }} parsed 解析结果。
 * @returns {string[]} 段名列表。
 */
export function listSections(parsed) {
  return [...parsed.sections.keys()].filter((name) => name !== '')
}

/**
 * 把 `[plugin] enabled` 写成指定布尔值，保留其余内容与注释。
 *
 * @param {string} text 原始 config.toml。
 * @param {boolean} value 目标值。
 * @returns {string} 改写后的 config.toml。
 */
export function setPluginEnabled(text, value) {
  const lines = String(text ?? '').split(/\r?\n/)
  const rendered = `enabled = ${value ? 'true' : 'false'}`

  let sectionStart = -1
  let sectionEnd = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const match = SECTION_RE.exec(stripComment(lines[index]).trim())
    if (!match) continue
    if (sectionStart === -1 && match[1].trim() === 'plugin') {
      sectionStart = index
      continue
    }
    if (sectionStart !== -1) {
      sectionEnd = index
      break
    }
  }

  if (sectionStart === -1) {
    const body = lines.join('\n').trimEnd()
    return `${body}${body ? '\n\n' : ''}[plugin]\n${rendered}\n`
  }

  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    const match = /^(\s*)enabled\s*=/.exec(lines[index])
    if (match) {
      lines[index] = `${match[1]}${rendered}`
      return lines.join('\n')
    }
  }

  lines.splice(sectionStart + 1, 0, rendered)
  return lines.join('\n')
}

/**
 * 去掉行内注释（忽略字符串里的 `#`）。
 *
 * @param {string} line 原始行。
 * @returns {string} 去注释后的行。
 */
function stripComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

/**
 * 解析单个 TOML 值。
 *
 * @param {string} raw 值文本。
 * @param {number} lineNo 行号（用于报错）。
 * @returns {unknown} 解析出的值。
 */
function parseValue(raw, lineNo) {
  const value = raw.trim()
  if (!value) throw new Error(`第 ${lineNo} 行缺少值`)

  if (value.startsWith('"') || value.startsWith("'")) {
    if (!value.endsWith(value[0]) || value.length < 2) throw new Error(`第 ${lineNo} 行字符串未闭合`)
    const inner = value.slice(1, -1)
    return value[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`第 ${lineNo} 行数组未闭合`)
    return splitArrayItems(value.slice(1, -1)).map((item) => parseValue(item, lineNo))
  }
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number.parseFloat(value)
  if (/^\d{4}-\d{2}-\d{2}([Tt ].*)?$/.test(value)) return value
  throw new Error(`第 ${lineNo} 行不支持的取值：${value}`)
}

/**
 * 按逗号切分内联数组，忽略字符串内的逗号。
 *
 * @param {string} inner 数组内容。
 * @returns {string[]} 各元素文本。
 */
function splitArrayItems(inner) {
  const items = []
  let quote = ''
  let buffer = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quote) {
      buffer += char
      if (char === '\\' && quote === '"') {
        buffer += inner[index + 1] ?? ''
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
      continue
    }
    if (char === ',') {
      items.push(buffer)
      buffer = ''
      continue
    }
    buffer += char
  }
  if (buffer.trim()) items.push(buffer)
  return items.map((item) => item.trim()).filter((item) => item.length > 0)
}
