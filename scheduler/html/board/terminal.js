// A view of a long text (the logs of a step): only the lines in sight are in the page. Optional view (SetView): a
// formatter that gives each line its HTML, the text it shows and what it knows of it, from the line and what it knew
// of the line before (format(raw, previousMeta) -> { text, html, meta }: e.g. the command a line continues), and a
// filter of the lines shown (filter({ raw, meta }) -> bool); without them, the text as it is.
export class Terminal {
  #isScrollbarActive
  #phantomDiv;
  #listeners;
  #format = null;
  #filter = null;

  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.lines = []; // buffered lines (shown: those the filter keeps, see #Shown)
    this.allLines = []; // every line, filter or not
    this.visibleStartLine = 0;
    this.visibleLines = 0;
    this.charsPerLine = 0;
    this.lineHeight = 0;
    this.charWidth = 0;

    this.scrollContainer = document.getElementById(`${containerId.replace('-container', '')}-scroll-overlay`);
    this.contentPre = document.getElementById(`${containerId.replace('-container', '')}-content`);

    this.#isScrollbarActive = false;

    this.#phantomDiv = document.createElement('div');
    this.#phantomDiv.style.width = '1px';
    this.#phantomDiv.style.height = '0px';
    this.scrollContainer.appendChild(this.#phantomDiv);

    this.#listeners = {
      onScroll: this.#OnScroll.bind(this),
      onMouseMove: this.#OnMouseMove.bind(this),
      onWheel: (event) => {
          event.preventDefault();
          this.scrollContainer.scrollTop += event.deltaY;
      }
    }

    this.#Init();
  }

  #Init() {
    this.#FontDimensions();
    this.#MeasureDimensions();

    this.scrollContainer.addEventListener('scroll', this.#listeners.onScroll);
    this.container.addEventListener('mousemove', this.#listeners.onMouseMove);
    this.contentPre.addEventListener('wheel', this.#listeners.onWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      this.#MeasureDimensions();
      this.#Render();
    });
    this.resizeObserver.observe(this.container);
  }

  #FontDimensions() {
    const testChar = document.createElement('span');
    testChar.textContent = 'M';
    testChar.style.visibility = 'hidden';
    testChar.style.position = 'absolute';
    testChar.style.fontFamily = getComputedStyle(this.contentPre).fontFamily;
    testChar.style.fontSize = getComputedStyle(this.contentPre).fontSize;
    testChar.style.lineHeight = getComputedStyle(this.contentPre).lineHeight;

    document.body.appendChild(testChar);
    this.charWidth = testChar.offsetWidth;
    this.lineHeight = testChar.offsetHeight;
    document.body.removeChild(testChar);
  }

  #MeasureDimensions() {
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;

    this.charsPerLine = Math.floor(containerWidth / this.charWidth);
    this.visibleLines = Math.ceil(containerHeight / this.lineHeight);
    // vertical padding of the text: the view shows that much less text than the container height
    const style = getComputedStyle(this.contentPre);
    this.verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  }

  // the lines of a text, in order: each one formatted with what was known of the one before (previous)
  #PrepareText(text, previous = null) {
    const out = [];
    for (const raw of text.split('\n')) {
      previous = this.#Line(raw, previous);
      out.push(previous);
    }
    return out;
  }

  #Line(raw, previous = null) {
    const shown = this.#format ? this.#format(raw, previous?.meta ?? null) : null;
    const content = shown ? shown.text : raw;
    return { raw, content, html: shown?.html ?? null, meta: shown?.meta ?? null, charCount: content.length };
  }

  // the formatter and the filter of the lines (null: none); the lines are formatted and filtered again
  SetView({ format = null, filter = null } = {}) {
    this.#format = format;
    this.#filter = filter;
    this.allLines = this.#PrepareText(this.allLines.map(line => line.raw).join('\n'));
    this.#Shown();
    this.visibleStartLine = Math.min(this.visibleStartLine, Math.max(0, this.lines.length - 1));
    this.#Render();
  }

  // the lines shown: those the filter keeps (the last line, possibly incomplete, is always kept)
  #Shown() {
    this.lines = this.#filter
        ? this.allLines.filter((line, i) => i === this.allLines.length - 1 || this.#filter(line)) : this.allLines;
  }

  Destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.scrollContainer.removeEventListener('scroll', this.#listeners.onScroll);
    this.container.removeEventListener('mousemove', this.#listeners.onMouseMove);
    this.contentPre.removeEventListener('wheel', this.#listeners.onWheel);
  }

  AppendText(text) {
    if (text.length === 0) return;
    // the last line was incomplete (no end of line yet): the new text continues it
    const last = this.allLines.pop();
    const newLines = this.#PrepareText((last?.raw ?? '') + text, this.allLines[this.allLines.length - 1] ?? null);
    for (const line of newLines) {
        this.allLines.push(line);
    }
    this.#Shown();

    // Auto-scroll only if already at the bottom
    const wasAtBottom = this.#IsAtBottom();

    this.#Render();

    if (wasAtBottom) {
      this.ScrollToBottom();
    }
  }

  SetText(text) {
    this.allLines = this.#PrepareText(text);
    this.#Shown();
    this.visibleStartLine = Math.min(this.visibleStartLine, Math.max(0, this.lines.length - 1));
    this.#Render();
  }

  Clear() {
    this.allLines = [];
    this.lines = [];
    this.visibleStartLine = 0;
    this.#Render();
  }

  #OnMouseMove(event) {
    const rect = this.scrollContainer.getBoundingClientRect();
    const scrollbarWidth = this.scrollContainer.offsetWidth - this.scrollContainer.clientWidth;
    const isOverScrollbar = event.clientX > rect.right - scrollbarWidth - 10; // generous margin
    if (isOverScrollbar && !this.#isScrollbarActive) {
      this.#isScrollbarActive = true;
      this.scrollContainer.style.pointerEvents = 'auto';
    } else if (!isOverScrollbar && this.#isScrollbarActive) {
      this.#isScrollbarActive = false;
      this.scrollContainer.style.pointerEvents = 'none';
    }
  }

  #OnScroll() {
    const scrollTop = this.scrollContainer.scrollTop;

    let cumulativeHeight = 0;
    let newStartLine = Math.max(0, this.lines.length - 1);

    for (let i = 0; i < this.lines.length; i++) {
        const visualLines = Math.ceil(this.lines[i].charCount / this.charsPerLine) || 1;
        const lineHeight = visualLines * this.lineHeight;

        if (cumulativeHeight + lineHeight > scrollTop) {
            newStartLine = i;
            break;
        }

        cumulativeHeight += lineHeight;
    }

    if (newStartLine !== this.visibleStartLine) {
        this.visibleStartLine = newStartLine;
        this.#Render();
    }
  }

  #Render() {
    const totalLines = this.lines.length;
    const bufferLines = 5;
    const targetVisualLines = this.visibleLines + bufferLines;

    let currentVisualLine = 0;
    let endLine = this.visibleStartLine;

    while (currentVisualLine < targetVisualLines && endLine < totalLines) {
        const visualLines = Math.ceil(this.lines[endLine].charCount / this.charsPerLine) || 1;
        currentVisualLine += visualLines;
        endLine++;
    }

    const totalVisualLines = this.lines.reduce((sum, line) =>
        sum + (Math.ceil(line.charCount / this.charsPerLine) || 1), 0
    );
    // scroll height of the content (plus a spare line): at the bottom, the last line is at the bottom of the
    // view, not at its top above an empty view
    const phantomHeight = Math.max((totalVisualLines + 1) * this.lineHeight + (this.verticalPadding ?? 0),
        this.container.clientHeight);
    this.#phantomDiv.style.height = `${phantomHeight}px`

    const visibleLines = this.lines.slice(this.visibleStartLine, endLine);
    if (this.#format) {
      const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      this.contentPre.innerHTML = visibleLines.map(line => line.html ?? esc(line.content)).join('\n');
    } else {
      this.contentPre.textContent = visibleLines.map(line => line.content).join('\n');
    }
  }

  ScrollToBottom() {
    this.scrollContainer.scrollTop =
        this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight;
  }

  ScrollToTop() {
    this.scrollContainer.scrollTop = 0;
  }

  ScrollToLine(lineNumber) {
    this.scrollContainer.scrollTop = lineNumber * this.lineHeight;
  }

  #IsAtBottom() {
    const maxScroll = this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight;
    return Math.abs(this.scrollContainer.scrollTop - maxScroll) < this.lineHeight;
  }

  GetLineCount() {
    return this.lines.length;
  }
}
