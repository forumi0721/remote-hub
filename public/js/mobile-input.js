export const TERMINAL_KEYS = {
  Escape: '\x1b', Tab: '\t', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  CtrlAltDel: '\x1b[3;7~', Interrupt: '\x03'
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

export function terminalKeySequence(key, { ctrl, alt, applicationCursorKeys }) {
  const sequence = TERMINAL_KEYS[key];
  if (!sequence || key === 'CtrlAltDel' || key === 'Interrupt') return sequence;
  if (key.startsWith('Arrow') || key.startsWith('Page')) {
    const modifier = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    if (modifier > 1) {
      const parameter = key.startsWith('Arrow') ? '1' : sequence.slice(2, -1);
      return `\x1b[${parameter};${modifier}${sequence.at(-1)}`;
    }
    if (applicationCursorKeys && key.startsWith('Arrow')) return sequence.replace('[', 'O');
  }
  return alt ? '\x1b' + sequence : sequence;
}

export const VNC_KEYSYMS = {
  Escape: 0xff1b, Tab: 0xff09, ArrowLeft: 0xff51, ArrowUp: 0xff52,
  ArrowRight: 0xff53, ArrowDown: 0xff54, PageUp: 0xff55, PageDown: 0xff56,
  Delete: 0xffff, ControlLeft: 0xffe3, AltLeft: 0xffe9, KeyC: 0x63
};
