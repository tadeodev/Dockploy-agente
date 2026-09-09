// Cerrar un socket dispara eventos que vuelven a pedir el cierre. Sin esta
// guardia la llamada se reentra hasta agotar la pila y tumbar el agente.
export function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}
