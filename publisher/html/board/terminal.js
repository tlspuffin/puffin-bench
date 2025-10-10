export class Terminal {
  constructor(containerId) {
    this.container = document.getElementById(containerId);;
    this.lines = []; // Buffer de toutes les lignes
    this.visibleStartLine = 0; // Première ligne visible
    this.visibleLines = 0; // Nombre de lignes visibles
    this.charsPerLine = 0; // Largeur en caractères
    this.lineHeight = 0; // Hauteur d'une ligne en pixels
    this.charWidth = 0; // Largeur d'un caractère en pixels
    
    this.spacerTop = document.getElementById(`${containerId.replace('-container', '')}-spacer-top`);
    this.contentPre = document.getElementById(`${containerId.replace('-container', '')}-content`);
    this.spacerBottom = document.getElementById(`${containerId.replace('-container', '')}-spacer-bottom`);
    
    this.init();
  }
  
  init() {
    // Vider le container et créer la structure
    this.container.innerHTML = '';
    
    // Mesurer les dimensions
    this.measureDimensions();
    
    // Écouter les événements
    this.container.addEventListener('scroll', () => this.onScroll());
    
    // Observer les changements de taille
    this.resizeObserver = new ResizeObserver(() => {
      this.measureDimensions();
      this.render();
    });
    this.resizeObserver.observe(this.container);
  }
  
  measureDimensions() {
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
    
    // Calculer les dimensions du terminal
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    
    this.charsPerLine = Math.floor(containerWidth / this.charWidth);
    this.visibleLines = Math.ceil(containerHeight / this.lineHeight);
  }
  
  wrapText(text) {
    // Découper le texte en lignes selon la largeur
    const inputLines = text.split('\n');
    const wrappedLines = [];
    
    for (const line of inputLines) {
      if (line.length <= this.charsPerLine) {
        wrappedLines.push(line);
      } else {
        // Découper les lignes trop longues
        for (let i = 0; i < line.length; i += this.charsPerLine) {
          wrappedLines.push(line.slice(i, i + this.charsPerLine));
        }
      }
    }
    
    return wrappedLines;
  }
  
  appendText(text) {
    const newLines = this.wrapText(text);
    this.lines.push(...newLines);
    
    // Auto-scroll si on était en bas
    const wasAtBottom = this.isAtBottom();
    
    this.render();
    
    if (wasAtBottom) {
      this.scrollToBottom();
    }
  }
  
  setText(text) {
    this.lines = this.wrapText(text);
    this.visibleStartLine = 0;
    this.render();
  }
  
  clear() {
    this.lines = [];
    this.visibleStartLine = 0;
    this.render();
  }
  
  onScroll() {
    const scrollTop = this.container.scrollTop;
    const newStartLine = Math.floor(scrollTop / this.lineHeight);
    
    if (newStartLine !== this.visibleStartLine) {
      this.visibleStartLine = newStartLine;
      this.render();
    }
  }
  
  render() {
    const totalLines = this.lines.length;
    const endLine = Math.min(this.visibleStartLine + this.visibleLines + 5, totalLines); // +5 pour le buffer
    
    // Calculer les espaceurs
    const topSpacerHeight = this.visibleStartLine * this.lineHeight;
    const bottomSpacerHeight = Math.max(0, (totalLines - endLine) * this.lineHeight);
    
    // Mettre à jour les espaceurs
    this.spacerTop.style.height = topSpacerHeight + 'px';
    this.spacerBottom.style.height = bottomSpacerHeight + 'px';
    
    // Afficher les lignes visibles
    const visibleLines = this.lines.slice(this.visibleStartLine, endLine);
    this.contentPre.textContent = visibleLines.join('\n');
  }
  
  scrollToBottom() {
    const maxScroll = Math.max(0, (this.lines.length - this.visibleLines) * this.lineHeight);
    this.container.scrollTop = maxScroll;
  }
  
  scrollToTop() {
    this.container.scrollTop = 0;
  }
  
  scrollToLine(lineNumber) {
    const targetScroll = lineNumber * this.lineHeight;
    this.container.scrollTop = targetScroll;
  }
  
  isAtBottom() {
    const scrollTop = this.container.scrollTop;
    const maxScroll = Math.max(0, (this.lines.length - this.visibleLines) * this.lineHeight);
    return Math.abs(scrollTop - maxScroll) < this.lineHeight;
  }
  
  getLineCount() {
    return this.lines.length;
  }
  
  getVisibleRange() {
    return {
      start: this.visibleStartLine,
      end: Math.min(this.visibleStartLine + this.visibleLines, this.lines.length)
    };
  }
  
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.container.removeEventListener('scroll', this.onScroll);
  }
}

// Utilisation :
// const container = document.querySelector('.logs-content');
// const terminal = new Terminal(container);
// terminal.appendText('Hello World\n');
// terminal.appendText('This is a very long line that will be wrapped automatically when it exceeds the terminal width\n');