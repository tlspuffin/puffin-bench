/**
 * Lightweight toast notification service.
 * Creates a fixed-position container on first use and appends auto-dismissing toasts.
 */
class ErrorManager {
  #toastContainer = null;

  #getContainer() {
    if (!this.#toastContainer) {
      this.#toastContainer = document.getElementById('toast-container');
      if (!this.#toastContainer) {
        this.#toastContainer = document.createElement('div');
        this.#toastContainer.id = 'toast-container';
        this.#toastContainer.setAttribute('role', 'alert');
        this.#toastContainer.setAttribute('aria-live', 'polite');
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

  /**
   * Shows a red error toast and logs to console.error.
   * @param {string} message
   */
  Error(message) {
    console.error(message);
    this.#show(message, 'error');
  }

  /**
   * Shows a green success toast.
   * @param {string} message
   */
  Success(message) {
    this.#show(message, 'success');
  }

  /**
   * Shows a blue informational toast.
   * @param {string} message
   */
  Info(message) {
    this.#show(message, 'info');
  }
}

export { ErrorManager };
