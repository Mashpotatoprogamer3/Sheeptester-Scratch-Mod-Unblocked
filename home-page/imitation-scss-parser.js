// node home-page/imitation-scss-parser.js home-page/index.html.scss index.html home-page/style.css

const fs = require('fs/promises')
const nodePath = require('path')
const YAML = require('yaml')

function * tokenize (text, possibilities) {
  const tokenizers = [Object.entries(possibilities)]
  tokenization:
  while (text.length) {
    for (const [type, rawPossibility] of tokenizers[tokenizers.length - 1]) {
      const possibility = typeof rawPossibility === 'string' || rawPossibility instanceof RegExp
        ? { pattern: rawPossibility }
        : rawPossibility
      let token, groups
      if (typeof possibility.pattern === 'string') {
        if (text.startsWith(possibility.pattern)) {
          token = possibility.pattern
          text = text.slice(possibility.pattern.length)
        }
      } else {
        const match = text.match(possibility.pattern)
        if (match && match.index === 0) {
          token = match[0]
          groups = match
          text = text.slice(match[0].length)
        }
      }
      if (token) {
        if (possibility.pop) {
          tokenizers.pop()
        }
        if (possibility.push) {
          tokenizers.push(Object.entries(possibility.push))
        }
        yield [type, token, groups]
        continue tokenization
      }
    }
    console.error(text)
    throw new Error('Cannot tokenize from here.')
  }
}

const patternTokenizers = {
  in: {
    pattern: 'in',
    pop: true
  },
  variable: /^\$[\w-]+/,
  separator: ',',
  whitespace: /^\s+/
}
const cssRawTokenizers = {
  comment: /^\/\/.*/,
  string: /^(?:"(?:[^"\r\n\\]|\\.)*"|'(?:[^'\r\n\\]|\\.)*')/,
  lcurly: { pattern: /^\s*\{\s*/ },
  rcurly: { pattern: /^\s*}\s*/, pop: true },
  semicolon: /^\s*;\s*/,
  colon: /^\s*:\s*/,
  separator: /^\s*,\s*/,
  whitespace: /^\s+/,
  anythingElse: /^[^{}:,\s]+/
}
cssRawTokenizers.lcurly.push = cssRawTokenizers
const tokenizers = {
  multilineString: /^"""([^"\\]|\\.)*(?:"{1,2}([^"\\]|\\.)+)*"""/,
  string: /^"(?:[^"\r\n\\]|\\.)*"/,
  comment: /^\/\/.*/,
  cssRawBegin: { pattern: /^css\s*\{/, push: cssRawTokenizers },
  lparen: '(',
  rparen: ')',
  lbracket: '[',
  rbracket: ']',
  lcurly: '{',
  rcurly: '}',
  equal: '=',
  semicolon: ';',
  colon: ':',
  import: '@import',
  importFunc: /^import\s*\(\s*("(?:[^"\r\n\\]|\\.)*")\s*\)/,
  each: {
    pattern: '@each',
    push: patternTokenizers
  },
  mapGet: /^map\s*\.\s*get\s*\(\s*(\$[\w-]+)\s*,\s*'((?:[^'\r\n\\]|\\.)*)'\s*\)/,
  idName: /^#(?:[\w-]|#\{(?:\$[\w-]+|map\s*\.\s*get\s*\(\s*\$[\w-]+\s*,\s*'(?:[^'\r\n\\]|\\.)*'\s*\))\})+/,
  className: /^\.(?:[\w-]|#\{(?:\$[\w-]+|map\s*\.\s*get\s*\(\s*\$[\w-]+\s*,\s*'(?:[^'\r\n\\]|\\.)*'\s*\))\})+/,
  tagName: /^(?:[\w-]|#\{(?:\$[\w-]+|map\s*\.\s*get\s*\(\s*\$[\w-]+\s*,\s*'(?:[^'\r\n\\]|\\.)*'\s*\))\})+/,
  whitespace: /^\s+/
}

function startSelector (context) {
  context.type = 'selector'
  context.html = () => {
    const { tagName = 'div', classes = [], id, attributes = [] } = context
    if (classes.length) {
      attributes.push(['class', classes.join(' ')])
    }
    if (id) {
      attributes.push(['id', id])
    }
    return `<${tagName}${attributes.map(([name, value]) => value === undefined ? ' ' + name : ` ${name}="${escapeHtml(value)}"`).join('')}>`
  }
}

const escapeMap = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }
function escapeHtml (str) {
  return str.replace(/[<>&"]/g, m => escapeMap[m])
}

const substitutionPattern = /#\{(?:(\$[\w-]+)|map\s*\.\s*get\s*\(\s*(\$[\w-]+)\s*,\s*'((?:[^'\r\n\\]|\\.)*)'\s*\))\}/g

function trimMultilineString (str) {
  const contents = str.slice(3, -3)
  const firstIndentMatch = contents.match(/\n([ \t]*)/)
  return contents.replace(new RegExp(String.raw`\s*\n[ \t]{0,${
    firstIndentMatch
      ? firstIndentMatch[1].length
      : 0
  }}`, 'g'), ' ').trim()
}

async function parseImitationScss (psuedoScss, filePath, { html = '', css = '', noisy = false, variables = {} } = {}) {
  const tokens = tokenize(psuedoScss, tokenizers)
  const contextStack = [{}]
  async function loopOverArray (context, array) {
    const minLength = Math.min(...array.map(sublist => Array.isArray(sublist) ? sublist.length : 1))
    if (context.variables.length > minLength) {
      throw new RangeError(`Destructuring too many variables from a list of at minimum ${minLength} items`)
    }
    const loopTokens = []
    let brackets = 0
    while (true) {
      const { value: nextToken, done } = tokens.next()
      if (done) throw new Error('tokens should not be done; unbalanced curlies probably')
      loopTokens.push(nextToken)
      if (nextToken[0] === 'lcurly') {
        brackets++
      } else if (nextToken[0] === 'rcurly') {
        brackets--
        if (brackets <= 0) break
      }
    }
    let tempHtml = html
    let tempCss = css
    for (const entry of array) {
      contextStack.push({ type: 'each-loop' })
      css = ''
      html = ''
      const vars = { ...variables }
      if (context.variables.length === 1) {
        vars[context.variables[0]] = entry
      } else {
        if (!Array.isArray(entry)) {
          throw new TypeError('Cannot destructure from non-array')
        }
        context.variables.forEach((varName, i) => {
          vars[varName] = entry[i]
        })
      }
      for (const token of loopTokens) {
        await analyseToken(token, vars)
      }
      tempHtml += html
        .replace(substitutionPattern, (_, varName, mapName, key) => {
          if (mapName) {
            if (vars[mapName] === undefined) {
              throw new ReferenceError(`${mapName} not defined`)
            }
            if (vars[mapName] === null || typeof vars[mapName] !== 'object') {
              throw new TypeError('Not object')
            }
            if (vars[mapName][key] === undefined) {
              throw new ReferenceError(`${key} not not in map`)
            }
            return escapeHtml(vars[mapName][key])
          } else {
            if (vars[varName] === undefined) {
              throw new ReferenceError(`${varName} not defined`)
            }
            return escapeHtml(vars[varName])
          }
        })
      contextStack.pop() // each-loop
    }
    html = tempHtml
    css = tempCss + css
    contextStack.pop() // each
    contextStack.push({})
  }
  async function analyseToken ([tokenType, token, groups], variables) {
    let context = contextStack[contextStack.length - 1]
    if (noisy) console.log([tokenType, token], context)

    switch (tokenType) {
      case 'comment': {
        break
      }

      case 'tagName': {
        if (!context.type) {
          if (token === 'content') {
            context.type = 'content'
            context.step = 'after-content'
            break
          } else {
            startSelector(context)
          }
        }
        if (context.type === 'selector') {
          if (context.tagName) {
            throw new Error('Tag name already set')
          } else {
            context.tagName = token
          }
        } else if (context.type === 'attribute') {
          if (context.step === 'name') {
            context.name = token
            context.step = 'post-name'
          } else if (context.step === 'value') {
            context.value = token
            context.step = 'end'
          }
        } else {
          throw new Error('Invalid tag name context')
        }
        break
      }

      case 'className': {
        if (!context.type) startSelector(context)
        if (context.type === 'selector') {
          if (!context.classes) context.classes = []
          context.classes.push(token.slice(1))
        } else {
          throw new Error('Class token should only be in selector')
        }
        break
      }

      case 'idName': {
        if (!context.type) startSelector(context)
        if (context.type === 'selector') {
          if (context.id) {
            throw new Error('ID already set')
          } else {
            context.id = token.slice(1)
          }
        } else {
          throw new Error('Class token should only be in selector')
        }
        break
      }

      case 'lbracket': {
        if (!context.type) startSelector(context)
        if (context.type === 'selector') {
          contextStack.push({
            type: 'attribute',
            step: 'name'
          })
        } else {
          throw new Error('Left bracket should only be in selector')
        }
        break
      }

      case 'equal': {
        if (context.type === 'attribute') {
          if (context.step === 'post-name') {
            context.step = 'value'
          } else {
            throw new Error('Equal must be after name')
          }
        } else {
          throw new Error('Equal should only be in attribute')
        }
        break
      }

      case 'rbracket': {
        if (context.type === 'attribute') {
          if (context.step === 'post-name' || context.step === 'end') {
            contextStack.pop()
            const parentContext = contextStack[contextStack.length - 1]
            if (!parentContext.attributes) parentContext.attributes = []
            parentContext.attributes.push([context.name, context.value])
          } else {
            throw new Error('Right bracket must be after name or value')
          }
        } else {
          throw new Error('Right bracket should only be in attribute')
        }
        break
      }

      case 'multilineString':
      case 'string': {
        if (context.type === 'css') {
          context.css += token
          break
        }
        const strValue = tokenType === 'multilineString'
          ? trimMultilineString(token)
          : JSON.parse(token)
        const escaped = escapeHtml(strValue)
        if (context.type === 'attribute') {
          if (context.step === 'value') {
            context.value = strValue
            context.step = 'end'
          } else {
            throw new Error('String must be after equal sign')
          }
        } else if (context.type === 'content') {
          if (context.step === 'value') {
            html += escaped
            context.step = 'end'
          } else {
            throw new Error('String must be after colon')
          }
        } else if (context.type === 'import') {
          if (context.step === 'path') {
            const path = nodePath.join(nodePath.dirname(filePath), strValue)
            const imported = await parseImitationScss(await fs.readFile(path, 'utf8'), path, {
              noisy,
              variables
            })
            html += imported.html
            context.css += imported.css
            context.step = 'end'
          } else {
            throw new Error('String must be after colon')
          }
        } else {
          throw new Error('Invalid string context')
        }
        break
      }

      case 'whitespace': {
        if (context.type === 'selector') {
          context.encounteredWhiteSpace = true
        } else if (context.type === 'css') {
          context.css += ' '
        }
        break
      }

      case 'lcurly': {
        if (context.type === 'selector') {
          html += context.html()
          contextStack.push({})
        } else if (context.type === 'each-loop') {
          contextStack.push({})
        } else if (context.type === 'css') {
          context.css += '{'
          context.brackets++
        } else {
          throw new Error('Left curly in ivnalid context')
        }
        break
      }

      case 'rcurly': {
        if (context.type === 'css') {
          context.brackets--
          if (context.brackets <= 0) {
            css += context.css.trim()
            contextStack.pop()
            contextStack.push({})
          } else {
            context.css += '}'
          }
          break
        }
        contextStack.pop()
        context = contextStack[contextStack.length - 1]
        if (noisy) console.log('RCURLY', context)
        if (context.type === 'selector') {
          html += `</${context.tagName || 'div'}>`
          contextStack.pop()
          contextStack.push({})
        } else if (context.type === 'each-loop') {
          contextStack.pop()
          contextStack.push({})
        } else {
          throw new Error('Right curly\'s matching left curly in wrong context')
        }
        break
      }

      case 'semicolon': {
        if (context.type === 'selector') {
          html += context.html()
          contextStack.pop()
          contextStack.push({})
        } else if (context.type === 'content') {
          if (context.step === 'end') {
            contextStack.pop()
            contextStack.push({})
          } else {
            throw new Error('Colon must be after string')
          }
        } else if (context.type === 'import') {
          if (context.step === 'end') {
            contextStack.pop()
            contextStack.push({})
          } else {
            throw new Error('Colon must be after import path string')
          }
        } else if (context.type === 'css') {
          context.css += ';'
        } else {
          throw new Error('Invalid semicolon context')
        }
        break
      }

      case 'colon': {
        if (context.type === 'content') {
          if (context.step === 'after-content') {
            context.step = 'value'
          } else {
            throw new Error('Colon must be after `content`')
          }
        } else if (context.type === 'css') {
          context.css += ':'
        } else {
          throw new Error('Colon in wrong context')
        }
        break
      }

      case 'each': {
        if (!context.type) {
          context.type = 'each'
          context.variables = []
          context.step = 'variables'
        } else {
          throw new Error('Each cannot be used inside a context')
        }
        break
      }

      case 'variable': {
        if (context.type === 'each') {
          if (context.step === 'variables') {
            context.variables.push(token)
          } else {
            throw new Error('Variables must be after @each')
          }
        } else {
          throw new Error('Each cannot be used inside a context')
        }
        break
      }

      case 'separator': {
        if (context.type === 'css') {
          context.css += ','
        }
        break
      }

      case 'in': {
        if (context.type === 'each') {
          if (context.step === 'variables') {
            if (context.variables.length === 0) {
              throw new Error('Need at least one variable before `in`')
            }
            context.step = 'expr'
          } else {
            throw new Error('`in` must be after @each or variables')
          }
        } else {
          throw new Error('`in` should only be in @each')
        }
        break
      }

      case 'importFunc': {
        if (context.type === 'each') {
          if (context.step === 'expr') {
            const path = nodePath.join(nodePath.dirname(filePath), JSON.parse(groups[1]))
            const yaml = YAML.parse(await fs.readFile(path, 'utf8'))
            if (yaml === null || typeof yaml !== 'object') {
              throw new TypeError('Cannot loop over a non-array/object')
            }
            const array = Array.isArray(yaml)
              ? yaml
              : Object.entries(yaml)
            await loopOverArray(context, array)
          } else {
            throw new Error('Import function must only be used after in')
          }
        } else {
          throw new Error('Import function should only be in @each')
        }
        break
      }

      case 'import': {
        if (!context.type) {
          context.type = 'import'
          context.step = 'path'
        } else {
          throw new Error('@import cannot be inside a context')
        }
        break
      }

      case 'mapGet': {
        if (context.type === 'each') {
          if (context.step === 'expr') {
            if (variables[groups[1]] === undefined) {
              throw new ReferenceError(`${groups[1]} not defined`)
            }
            const array = variables[groups[1]][JSON.parse(`"${
              groups[2].replace(/"|\\'/g, m => m === '"' ? '\\"' : '\'')
            }"`)]
            if (!Array.isArray(array)) {
              console.error(array)
              throw new TypeError('Cannot loop over non-array')
            }
            await loopOverArray(context, array)
          } else {
            throw new Error('map.get function must only be used after in')
          }
        } else {
          throw new Error('map.get in wrong context')
        }
        break
      }

      case 'cssRawBegin': {
        if (!context.type) {
          context.type = 'css'
          context.brackets = 1
          context.css = ''
        } else {
          throw new Error('css cannot be inside a context')
        }
        break
      }

      case 'anythingElse': {
        if (context.type === 'css') {
          context.css += token
        } else {
          throw new Error('anythingElse must be inside css')
        }
        break
      }

      default: {
        console.error(html)
        throw new Error(`${tokenType} not implemented yet`)
      }
    }
  }
  for (const token of tokens) {
    await analyseToken(token, variables)
  }
  if (noisy) console.log(contextStack)
  return { html, css }
}

const [, , inputFile, outputHtml, outputCss] = process.argv
fs.readFile(inputFile, 'utf8')
  .then(async psuedoScss => {
    const { html, css } = await parseImitationScss(psuedoScss, inputFile, {
      html: '<!DOCTYPE html>',
      noisy: false
    })
    await fs.writeFile(
      outputHtml,
      html + `\n<!-- Generated from ${inputFile} -->\n`
    )
    await fs.writeFile(
      outputCss,
      css + `\n/* Generated from ${inputFile} */\n`
    )
  })
