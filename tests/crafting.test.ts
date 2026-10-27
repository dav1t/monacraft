import { describe, expect, it } from 'vitest'
import { describeRecipes } from '../src/tools/crafting.ts'

describe('describeRecipes', () => {
  it('collapses wood variants into one "any planks" option', () => {
    const recipes = ['cherry', 'bamboo', 'mangrove', 'oak'].map((wood) => [
      { name: `${wood}_planks`, count: 3 },
      { name: 'stick', count: 2 },
    ])
    expect(describeRecipes(recipes)).toEqual(['3 of any planks + 2 stick'])
  })

  it('keeps a single-variant recipe specific', () => {
    expect(describeRecipes([[{ name: 'oak_planks', count: 5 }]])).toEqual(['5 oak_planks'])
  })

  it('keeps genuinely different recipes apart', () => {
    const recipes = [
      [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      [{ name: 'blackstone', count: 3 }, { name: 'stick', count: 2 }],
    ]
    expect(describeRecipes(recipes)).toEqual(['3 cobblestone + 2 stick', '3 blackstone + 2 stick'])
  })
})
