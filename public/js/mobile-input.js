export const TERMINAL_KEYS = {
  Escape: '\x1b', Tab: '\t', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Interrupt: '\x03'
};

export function terminalControlCharacter(text) {
  if ([...text].length !== 1) return text;
  const code = text.toUpperCase().charCodeAt(0);
  if (text === ' ') return '\x00';
  return code >= 64 && code <= 95 ? String.fromCharCode(code & 31) : text;
}

export function sendRdpText(session, text, { DeviceEvent, InputTransaction }) {
  // Send bounded transactions, preserving Unicode composition committed in the text field.
  const characters = [...text.replace(/\r\n/g, '\n')];
  for (let start = 0; start < characters.length; start += 64) {
    const transaction = new InputTransaction();
    for (const character of characters.slice(start, start + 64)) {
      const scanCode = character === '\n' ? 0x1c : character === '\t' ? 0x0f : null;
      transaction.addEvent(scanCode === null ? DeviceEvent.unicodePressed(character) : DeviceEvent.keyPressed(scanCode));
      transaction.addEvent(scanCode === null ? DeviceEvent.unicodeReleased(character) : DeviceEvent.keyReleased(scanCode));
    }
    session.applyInputs(transaction);
  }
}
