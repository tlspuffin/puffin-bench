class ErrorManager {
  #toastContainer = null;

  #getContainer() {
    if (!this.#toastContainer) {
      this.#toastContainer = document.getElementById('toast-container');
      if (!this.#toastContainer) {
        this.#toastContainer = document.createElement('div');
        this.#toastContainer.id = 'toast-container';
        document.body.appendChild(this.#toastContainer);
      }
    }
    return this.#toastContainer;
  }

  #show(message, type) {
    const container = this.#getContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.classList.add('toast-visible'); });
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 4000);
  }

  Error(message) {
    console.error(message);
    this.#show(message, 'error');
  }

  Success(message) {
    this.#show(message, 'success');
  }

  Info(message) {
    this.#show(message, 'info');
  }
}

export { ErrorManager };
