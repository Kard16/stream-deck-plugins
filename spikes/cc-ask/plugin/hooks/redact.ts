// The deck's token never reaches the log (PROTOCOL.md, "Transport"), whole or in pieces, whatever text it hides in:
// an error's message, a bridge's answer, another variable's value. A text that's cut short for the log has the token
// hidden before the cut (bridge.ts's clip(), desktop.ts's shown()), so the cut can't halve it and leave a piece too
// short to be known; and each log line has it hidden again, whole.

/** A piece of the token this long or longer is hidden wherever it is: a text cut short can end in one. */
export const TOKEN_RUN = 8

/**
 * `text` with the token in it put as `<token>`, and with it every run of TOKEN_RUN or more of the token's
 * characters, such as the start of one in a text the engine had already cut short. With `max`, it stops once it
 * has more than that many characters to give back, so a long text costs no more than a short one.
 */
export function redact(text: string, token: string, max = Number.POSITIVE_INFINITY): string {
  if (token === '') return text
  // A token shorter than a run is hidden only whole.
  const least = Math.min(TOKEN_RUN, token.length)
  let out = ''
  let copied = 0
  let i = 0
  while (i < text.length && out.length + i - copied <= max) {
    const n = runAt(text, i, token)
    if (n >= least) {
      out += `${text.slice(copied, i)}<token>`
      i += n
      copied = i
    } else i++
  }
  return out + text.slice(copied, i)
}

/** The length of the longest piece of `token` that `text` holds from `at` on. */
function runAt(text: string, at: number, token: string): number {
  let best = 0
  for (let j = 0; j + best < token.length; j++) {
    let n = 0
    while (at + n < text.length && j + n < token.length && text[at + n] === token[j + n]) n++
    if (n > best) best = n
  }
  return best
}
