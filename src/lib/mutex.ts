/** Runs async functions one at a time, in call order. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn)
    this.#tail = result.catch(() => {})
    return result
  }
}
