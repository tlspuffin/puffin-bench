export class Terminal {
  #isScrollbarActive
  #phantomDiv;
  #listeners;

  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.lines = []; // buffered lines
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
  }
  
  #PrepareText(text) {
    const inputLines = text.split('\n');
    return inputLines.map(line => ({
        content: line,
        charCount: line.length
    }));
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
    const newLines = this.#PrepareText(text);
    if (newLines.length === 0) return;

    if ((this.lines.length > 0) && 
        (this.lines[this.lines.length - 1].charCount == 0)) {
      this.lines[this.lines.length - 1] = newLines.shift();
    }
    for (const line of newLines) {
        this.lines.push(line);
    }
    
    // Auto-scroll only if already at the bottom
    const wasAtBottom = this.#IsAtBottom();
    
    this.#Render();
    
    if (wasAtBottom) {
      this.ScrollToBottom();
    }
  }
  
  SetText(text) {
    this.lines = this.#PrepareText(text);
    this.visibleStartLine = Math.min(this.visibleStartLine, Math.max(0, this.lines.length - 1));
    this.#Render();
  }
  
  Clear() {
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
    const phantomHeight = (totalVisualLines - 1) * this.lineHeight + this.container.clientHeight;
    this.#phantomDiv.style.height = `${phantomHeight}px`
    
    const visibleLines = this.lines.slice(this.visibleStartLine, endLine);
    this.contentPre.textContent = visibleLines.map(line => line.content).join('\n');
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
