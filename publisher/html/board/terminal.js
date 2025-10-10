export class Terminal {
  #isScrollbarActive

  constructor(containerId) {
    this.container = document.getElementById(containerId);;
    this.lines = []; // Buffer de toutes les lignes
    this.visibleStartLine = 0; // Première ligne visible
    this.visibleLines = 0; // Nombre de lignes visibles
    this.charsPerLine = 0; // Largeur en caractères
    this.lineHeight = 0; // Hauteur d'une ligne en pixels
    this.charWidth = 0; // Largeur d'un caractère en pixels
    
    this.scrollContainer = document.getElementById(`${containerId.replace('-container', '')}-scroll-overlay`);
    this.contentPre = document.getElementById(`${containerId.replace('-container', '')}-content`);
    
    this.#isScrollbarActive = false;

    this. #Init();
  }
  
  #Init() {
    // Mesurer les dimensions
    this.#FontDimensions();
    
    // Écouter les événements
    this.scrollContainer.addEventListener('scroll', () => this.#OnScroll());
    this.container.addEventListener('mousemove', (e) => {
        const rect = this.scrollContainer.getBoundingClientRect();
        const scrollbarWidth = this.scrollContainer.offsetWidth - this.scrollContainer.clientWidth;
        const isOverScrollbar = e.clientX > rect.right - scrollbarWidth - 10; // Marge généreuse
        if (isOverScrollbar && !this.#isScrollbarActive) {
          this.#isScrollbarActive = true;
          this.scrollContainer.style.pointerEvents = 'auto';
        } else if (!isOverScrollbar && this.#isScrollbarActive) {
          this.#isScrollbarActive = false;
          this.scrollContainer.style.pointerEvents = 'none';
        }
    });
    this.contentPre.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.scrollContainer.scrollTop += e.deltaY;
    });
    
    // Observer les changements de taille
    this.resizeObserver = new ResizeObserver(() => {
      this.#MeasureDimensions();
      this.#Render();
    });
    this.resizeObserver.observe(this.container);
  }
  
  #FontDimensions() {
    // Mesurer avec un caractère test
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

    console.log(this.charWidth, this.lineHeight);
  }

  #MeasureDimensions() {
    // Calculer les dimensions du terminal
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    
    this.charsPerLine = Math.floor(containerWidth / this.charWidth);
    this.visibleLines = Math.ceil(containerHeight / this.lineHeight);

    console.log(containerWidth, containerHeight);
  }
  
  #PrepareText(text) {
    const inputLines = text.split('\n');
    return inputLines.map(line => ({
        content: line,
        charCount: line.length
    }));
  }
  
  AppendText(text) {
    const newLines = this.#PrepareText(text);
    //this.lines.push(...newLines);
    for (const line of newLines) {
        this.lines.push(line);
    }
    
    // Auto-scroll si on était en bas
    const wasAtBottom = this.#IsAtBottom();
    
    this.#Render();
    
    if (wasAtBottom) {
      this.ScrollToBottom();
    }
  }
  
  SetText(text) {
    this.lines = this.#PrepareText(text);
    this.visibleStartLine = 0;
    this.#Render();
  }
  
  Clear() {
    this.lines = [];
    this.visibleStartLine = 0;
    this.#Render();
  }
  
  #OnScroll() {
    const scrollTop = this.scrollContainer.scrollTop;
    
    // Trouver quelle ligne logique correspond à scrollTop
    let cumulativeHeight = 0;
    let newStartLine = 0;
    
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
    
    // Calculer endLine en fonction des lignes visuelles réelles
    let currentVisualLine = 0;
    let endLine = this.visibleStartLine;
    
    while (currentVisualLine < targetVisualLines && endLine < totalLines) {
        const visualLines = Math.ceil(this.lines[endLine].charCount / this.charsPerLine) || 1;
        currentVisualLine += visualLines;
        endLine++;
    }
    
    // Calculer les espaceurs basés sur les lignes visuelles
    const totalVisualLines = this.lines.reduce((sum, line) => 
        sum + (Math.ceil(line.charCount / this.charsPerLine) || 1), 0
    );
    const phantomHeight = totalVisualLines * this.lineHeight;
    this.scrollContainer.innerHTML = `<div style="height: ${phantomHeight}px; width: 1px;"></div>`;
    
    // Afficher les lignes visibles
    const visibleLines = this.lines.slice(this.visibleStartLine, endLine);
    this.contentPre.textContent = visibleLines.map(line => line.content).join('\n');
  }
  
  ScrollToBottom() {
    const maxScroll = Math.max(0, (this.lines.length - this.visibleLines) * this.lineHeight);
    this.scrollContainer.scrollTop = maxScroll;
  }
  
  ScrollToTop() {
    this.scrollContainer.scrollTop = 0;
  }
  
  ScrollToLine(lineNumber) {
    const targetScroll = lineNumber * this.lineHeight;
    this.scrollContainer.scrollTop = targetScroll;
  }
  
  #IsAtBottom() {
    const scrollTop = this.scrollContainer.scrollTop;
    const maxScroll = Math.max(0, (this.lines.length - this.visibleLines) * this.lineHeight);
    return Math.abs(scrollTop - maxScroll) < this.lineHeight;
  }
  
  GetLineCount() {
    return this.lines.length;
  }
  
  GetVisibleRange() {
    return {
      start: this.visibleStartLine,
      end: Math.min(this.visibleStartLine + this.visibleLines, this.lines.length)
    };
  }
  
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.container.removeEventListener('scroll', this.#OnScroll);
  }
}

// Utilisation :
// const container = document.querySelector('.logs-content');
// const terminal = new Terminal(container);
// terminal.appendText('Hello World\n');
// terminal.appendText('This is a very long line that will be wrapped automatically when it exceeds the terminal width\n');