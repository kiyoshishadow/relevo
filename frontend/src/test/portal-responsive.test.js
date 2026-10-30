import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const css = await readFile(new URL('../styles/app.css', import.meta.url), 'utf8')

test('el héroe mantiene dos columnas en escritorio y pone el teléfono antes de la consulta en móvil', () => {
  assert.match(css, /\.hero\s*\{[^}]*grid-template-columns:\s*1\.05fr\s+\.95fr/s)

  const mobile = css.match(/@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)\n\}/)?.[1]
  assert.ok(mobile, 'debe existir el breakpoint de disposición móvil')
  assert.match(mobile, /\.hero\s*\{[^}]*grid-template-columns:\s*1fr/)
  assert.match(mobile, /\.hero-art\s*\{[^}]*order:\s*-1/)
  assert.match(mobile, /\.hero-copy\s*\{[^}]*order:\s*0/)
})

test('el teléfono se compacta en pantallas estrechas y los controles conservan área táctil', () => {
  const narrow = [...css.matchAll(/@media\s*\(max-width:\s*560px\)\s*\{([\s\S]*?)\n\}/g)]
    .map(match => match[1])
    .find(block => block.includes('.phone-stage'))
  assert.ok(narrow, 'debe existir un ajuste para móviles estrechos')
  assert.match(narrow, /\.phone-stage\s*\{[^}]*max-width:\s*clamp\(/)
  assert.match(narrow, /\.hero-form\s+input,\s*\.hero-form\s+\.btn\s*\{[^}]*min-height:\s*44px/)
  assert.match(narrow, /\.hero-form\s+\.btn\s*\{[^}]*width:\s*100%/)
})
