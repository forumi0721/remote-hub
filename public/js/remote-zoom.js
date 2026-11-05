import RFB from '/novnc/core/rfb.js';

// noVNC의 표시 배율을 바꾸면 포인터 좌표도 같은 배율로 변환된다.
export class ZoomableRfb extends RFB {
  setZoom(scale) {
    this.manualZoom = scale;
    this._updateScale();
  }

  _updateScale() {
    if (this.manualZoom == null) {
      super._updateScale();
      return;
    }
    this._display.scale = this.manualZoom;
    this._fixScrollbars();
  }
}

export function changeRemoteZoom(session, canvas, factor, x, y) {
  if (!canvas?.width || !canvas.height) return;
  const before = canvas.getBoundingClientRect();
  if (!before.width || !before.height) return;
  const viewport = session.engine === 'vnc' ? canvas.parentElement : session.viewEl;
  const area = viewport.getBoundingClientRect();
  x ??= area.left + area.width / 2;
  y ??= area.top + area.height / 2;
  const scale = Math.max(0.1, Math.min(4, before.width / canvas.width * factor));
  session.zoom = scale;
  if (session.engine === 'vnc') {
    session.instance.setZoom(scale);
  } else {
    session.viewEl.style.alignItems = 'flex-start';
    session.viewEl.style.justifyContent = 'flex-start';
    Object.assign(canvas.style, {
      maxWidth: 'none', maxHeight: 'none', objectFit: 'none', margin: 'auto',
    });
    // CSS 픽셀 크기를 원격 해상도와 독립적으로 지정한다.
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
  }
  const after = canvas.getBoundingClientRect();
  viewport.scrollLeft += after.left + (x - before.left) * after.width / before.width - x;
  viewport.scrollTop += after.top + (y - before.top) * after.height / before.height - y;
}

export function setupVncPinch(canvas, zoom) {
  let distance = 0;
  let drag;
  function onGesture(event) {
    if (event.detail.type === 'twodrag') {
      const viewport = canvas.parentElement;
      if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return;
      event.stopImmediatePropagation();
      const { magnitudeX: x, magnitudeY: y } = event.detail;
      if (event.type === 'gesturemove' && drag) viewport.scrollBy(drag.x - x, drag.y - y);
      drag = event.type === 'gestureend' ? null : { x, y };
      return;
    }
    if (event.detail.type !== 'pinch') return;
    // noVNC의 기본 pinch 동작(Ctrl+휠)을 로컬 화면 확대/축소로 바꾼다.
    event.stopImmediatePropagation();
    const next = Math.hypot(event.detail.magnitudeX, event.detail.magnitudeY);
    if (event.type === 'gesturemove' && distance && next) {
      zoom(next / distance, event.detail.clientX, event.detail.clientY);
    }
    distance = event.type === 'gestureend' ? 0 : next;
  }
  const events = ['gesturestart', 'gesturemove', 'gestureend'];
  for (const event of events) canvas.addEventListener(event, onGesture, true);
  return () => {
    for (const event of events) canvas.removeEventListener(event, onGesture, true);
  };
}
