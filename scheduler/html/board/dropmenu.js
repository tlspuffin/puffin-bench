export class DropMenu {
  #ui;
  #actionsDiv;
  static #style = null;
  static #widgets = new Set();
  static #lastLabelEvent = null;
  static #lastLabel = null;

  constructor({ label, actions }) {
    if (DropMenu.#style === null) {
      DropMenu.#CreateStyle();
      document.head.appendChild(DropMenu.#style);
      document.addEventListener('click', DropMenu.#ClickDocument);
    }
    this.#ui = document.createElement('div');
    this.#ui.className = '_dm_Root';
    const labelDiv = document.createElement('div');
    labelDiv.innerText = label;
    labelDiv.onclick = this.#Click.bind(this);
    labelDiv.className = '_dm_Label';
    this.#ui.appendChild(labelDiv);
    this.#actionsDiv = document.createElement('div');
    this.#actionsDiv.className = '_dm_Actions';
    this.#actionsDiv.classList.add('_dm_Hide');
    this.#actionsDiv.onclick = this.#ClickActionDiv.bind(this);
    actions.forEach((action) => {
      const div = document.createElement('div');
      div.appendChild(action);
      this.#actionsDiv.appendChild(div);
    });
    this.#ui.append(this.#actionsDiv);
  }

  Get() {
    DropMenu.#widgets.add(this);
    return this.#ui;
  }

  Delete() {
    if (DropMenu.#lastLabel === this) {
      DropMenu.#lastLabel = null;
      DropMenu.#lastLabelEvent = null
    }
    DropMenu.#widgets.delete(this);
  }

  static #CreateStyle() {
    DropMenu.#style = document.createElement('style');
    DropMenu.#style.innerHTML = `
      ._dm_Hide {
        display: none !important
      }
      ._dm_Root {
        position: relative;
      }
      ._dm_Label {
        user-select: none;
        cursor: pointer;
      }
      ._dm_Actions {
        width: max-content;
        position: absolute;
        right: 0px;
        background: black;
        border-radius: 10px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: center;
        z-index: 9999;
      }
    `;
  }

  #ClickActionDiv(event) {
    if (event.target.nodeName === 'BUTTON') {
      this.#actionsDiv.classList.toggle('_dm_Hide');
    }
  }

  #Click(event) {
    DropMenu.#lastLabelEvent = event;
    DropMenu.#lastLabel = this;
    this.#actionsDiv.classList.toggle('_dm_Hide');
  }

  static #ClickDocument(event) {
    const dropmenu = event.target.closest('._dm_Actions');
    if (!dropmenu) {
      DropMenu.#widgets.forEach(widget => {
        if ((widget === DropMenu.#lastLabel) && (event === DropMenu.#lastLabelEvent)) {
          return;
        }
        widget.#actionsDiv.classList.add('_dm_Hide');
        console.log(widget, event);
        console.log(DropMenu.#lastLabel, DropMenu.#lastLabelEvent);
      });
    }
  }
};
