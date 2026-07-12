import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const entityContainerSource = readFileSync(
    new URL('../src/containers/EntityContainer.ts', import.meta.url),
    'utf8'
).replaceAll('\r\n', '\n')
const blueprintContainerSource = readFileSync(
    new URL('../src/containers/BlueprintContainer.ts', import.meta.url),
    'utf8'
).replaceAll('\r\n', '\n')

function extractMethodBody(source, declaration) {
    const start = source.indexOf(declaration)
    assert.ok(start >= 0, `${declaration} should exist`)
    const openingBrace = source.indexOf('{', start)
    assert.ok(openingBrace >= 0, `${declaration} should have a body`)

    let depth = 0
    for (let index = openingBrace; index < source.length; index++) {
        if (source[index] === '{') depth++
        if (source[index] !== '}') continue
        depth--
        if (depth === 0) return source.slice(openingBrace + 1, index)
    }
    assert.fail(`${declaration} should have a balanced closing brace`)
}

test('EntityContainer exposes a defensive copy of its composed render sprites', () => {
    const body = extractMethodBody(entityContainerSource, 'public getRenderSprites')
    const getRenderSprites = new Function(body) // eslint-disable-line no-new-func
    const sprites = [{ id: 'base' }, { id: 'overlay' }]

    const result = getRenderSprites.call({ entitySprites: sprites })

    assert.deepEqual(result, sprites)
    assert.notEqual(result, sprites, 'callers must not mutate EntityContainer ownership')
})

test('BlueprintContainer resolves composed sprites and pixel origin by entity number', () => {
    const body = extractMethodBody(blueprintContainerSource, 'public getEntityRenderData')
    const getEntityRenderData = new Function('EntityContainer', 'entityNumber', body) // eslint-disable-line no-new-func
    const sprites = [{ id: 'body' }, { id: 'connector' }]
    const entity = {
        position: { x: 48, y: 80 },
        getRenderSprites: () => [...sprites],
    }
    const EntityContainer = { mappings: new Map([[7, entity]]) }

    assert.deepEqual(getEntityRenderData(EntityContainer, 7), {
        origin: { x: 48, y: 80 },
        sprites,
    })
    assert.equal(getEntityRenderData(EntityContainer, 99), undefined)
})
