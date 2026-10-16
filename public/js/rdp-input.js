// RDP PS/2 Set 1 Scancode Mapping for ironrdp-wasm
export const SCANCODE_MAP = {
  'Escape': 0x01, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
  'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
  'Digit8': 0x09, 'Digit9': 0x0A, 'Digit0': 0x0B, 'Minus': 0x0C,
  'Equal': 0x0D, 'Backspace': 0x0E, 'Tab': 0x0F,
  'KeyQ': 0x10, 'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13,
  'KeyT': 0x14, 'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17,
  'KeyO': 0x18, 'KeyP': 0x19, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
  'Enter': 0x1C, 'ControlLeft': 0x1D,
  'KeyA': 0x1E, 'KeyS': 0x1F, 'KeyD': 0x20, 'KeyF': 0x21,
  'KeyG': 0x22, 'KeyH': 0x23, 'KeyJ': 0x24, 'KeyK': 0x25,
  'KeyL': 0x26, 'Semicolon': 0x27, 'Quote': 0x28, 'Backquote': 0x29,
  'ShiftLeft': 0x2A, 'Backslash': 0x2B,
  'KeyZ': 0x2C, 'KeyX': 0x2D, 'KeyC': 0x2E, 'KeyV': 0x2F,
  'KeyB': 0x30, 'KeyN': 0x31, 'KeyM': 0x32, 'Comma': 0x33,
  'Period': 0x34, 'Slash': 0x35, 'ShiftRight': 0x36,
  'NumpadMultiply': 0x37, 'AltLeft': 0x38, 'Space': 0x39,
  'CapsLock': 0x3A,
  'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D, 'F4': 0x3E,
  'F5': 0x3F, 'F6': 0x40, 'F7': 0x41, 'F8': 0x42,
  'F9': 0x43, 'F10': 0x44,
  'NumLock': 0x45, 'ScrollLock': 0x46,
  'Numpad7': 0x47, 'Numpad8': 0x48, 'Numpad9': 0x49,
  'NumpadSubtract': 0x4A, 'Numpad4': 0x4B, 'Numpad5': 0x4C,
  'Numpad6': 0x4D, 'NumpadAdd': 0x4E, 'Numpad1': 0x4F,
  'Numpad2': 0x50, 'Numpad3': 0x51, 'Numpad0': 0x52,
  'NumpadDecimal': 0x53,
  'F11': 0x57, 'F12': 0x58,
  'NumpadEnter': 0xE01C, 'ControlRight': 0xE01D,
  'NumpadDivide': 0xE035, 'PrintScreen': 0xE037,
  'AltRight': 0xE038, 'Home': 0xE047, 'ArrowUp': 0xE048,
  'PageUp': 0xE049, 'ArrowLeft': 0xE04B, 'ArrowRight': 0xE04D,
  'End': 0xE04F, 'ArrowDown': 0xE050, 'PageDown': 0xE051,
  'Insert': 0xE052, 'Delete': 0xE053,
  'MetaLeft': 0xE05B, 'MetaRight': 0xE05C, 'ContextMenu': 0xE05D,
  'Pause': 0xE11D45
};

export function setupRdpInputHandlers(canvas, getSession, { DeviceEvent, InputTransaction }) {
  const onKeyDown = (e) => {
    const session = getSession();
    if (!session) return;

    const scancode = SCANCODE_MAP[e.code];
    if (scancode === undefined) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      const event = DeviceEvent.keyPressed(scancode);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Key press error:', err);
    }
  };

  const onKeyUp = (e) => {
    const session = getSession();
    if (!session) return;

    const scancode = SCANCODE_MAP[e.code];
    if (scancode === undefined) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      const event = DeviceEvent.keyReleased(scancode);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Key release error:', err);
    }
  };

  const onMouseMove = (e) => {
    const session = getSession();
    if (!session) return;

    try {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);

      const event = DeviceEvent.mouseMove(x, y);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (_) {}
  };

  const onMouseDown = (e) => {
    const session = getSession();
    if (!session) return;
    canvas.focus();
    e.preventDefault();

    try {
      const event = DeviceEvent.mouseButtonPressed(e.button);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Mouse down error:', err);
    }
  };

  const onMouseUp = (e) => {
    const session = getSession();
    if (!session) return;
    e.preventDefault();

    try {
      const event = DeviceEvent.mouseButtonReleased(e.button);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Mouse up error:', err);
    }
  };

  const onWheel = (e) => {
    const session = getSession();
    if (!session) return;
    e.preventDefault();

    try {
      if (e.deltaY !== 0) {
        const amount = e.deltaY > 0 ? -1 : 1;
        const event = DeviceEvent.wheelRotations(true, amount, 1);
        const tx = new InputTransaction();
        tx.addEvent(event);
        session.applyInputs(tx);
      }
      if (e.deltaX !== 0) {
        const amount = e.deltaX > 0 ? -1 : 1;
        const event = DeviceEvent.wheelRotations(false, amount, 1);
        const tx = new InputTransaction();
        tx.addEvent(event);
        session.applyInputs(tx);
      }
    } catch (err) {
      console.warn('[RDP Input] Wheel error:', err);
    }
  };

  const onContextMenu = (e) => e.preventDefault();

  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  // 리스너 해제 함수 반환
  return () => {
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
  };
}

export function sendRdpCtrlAltDel(session, { DeviceEvent, InputTransaction }) {
  if (!session) return;
  try {
    const tx = new InputTransaction();
    // Ctrl + Alt + Del
    tx.addEvent(DeviceEvent.keyPressed(0x1D));   // ControlLeft
    tx.addEvent(DeviceEvent.keyPressed(0x38));   // AltLeft
    tx.addEvent(DeviceEvent.keyPressed(0xE053)); // Delete
    tx.addEvent(DeviceEvent.keyReleased(0xE053));
    tx.addEvent(DeviceEvent.keyReleased(0x38));
    tx.addEvent(DeviceEvent.keyReleased(0x1D));
    session.applyInputs(tx);
  } catch (err) {
    console.warn('[RDP] Failed to send Ctrl+Alt+Del:', err);
  }
}
