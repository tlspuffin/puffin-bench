// Prototype d'étude : widget "ListInput" utilisable comme :
//
//   const listInput = new ListInput(getList, onChange, 'jl');
//   document.body.appendChild(listInput.node);
//
// Callbacks :
//   getList()       -> array de strings, appelé uniquement à l'ouverture
//                       du dropdown. Pas de filtrage par le texte tapé :
//                       la liste est toujours complète et statique tant
//                       que le dropdown reste ouvert.
//   onChange(value) -> appelé quand la value change, que ce soit par
//                       frappe clavier ou par sélection dans la liste.
//
// classPrefix (3e argument, optionnel, défaut 'li') -> préfixe commun
// pour toutes les classes de structure posées par le widget : avec
// 'jl' on obtient jl-wrap / jl-input / jl-dropdown / jl-list / jl-item,
// réutilisables tel quel avec les styles déjà définis dans
// joblauncher.css (à condition d'y ajouter les règles manquantes,
// jl-wrap/jl-input n'existent pas encore dans ce fichier).
// Le modificateur d'état 'open' reste volontairement non préfixé (il
// n'est jamais utilisé seul, toujours en classe composée
// `.<prefix>-dropdown.open`), comme le fait déjà joblauncher.css avec
// 'open'/'selected'/'active' sur ses propres classes préfixées jl-*.
//
// Positionnement : même bug que dans joblauncher.js à l'origine
// (position calculée une fois, coordonnées viewport = position:fixed
// nécessaire), mais ici corrigé avec un listener 'scroll' en phase de
// capture sur `document` — ça intercepte le scroll de N'IMPORTE QUEL
// ancêtre scrollable sans avoir à le connaître explicitement (les
// events 'scroll' ne bubble pas après la cible, mais traversent bien
// la phase de capture depuis document jusqu'à la cible).

export class ListInput {
  #getList;
  #onChange;
  #prefix;
  #inputEl;
  #dropdownEl;
  #listEl;
  #boundReposition = () => this.#position();
  #items = [];
  #activeIndex = -1;

  node; // élément racine, à appendChild() où on veut dans la page

  constructor(getList, onChange, classPrefix = 'li') {
    this.#getList  = getList;
    this.#onChange = onChange;
    this.#prefix   = classPrefix;
    this.#buildDOM();
  }

  // ex: this.#cls('item') -> 'jl-item' si classPrefix === 'jl'
  #cls(suffix) { return `${this.#prefix}-${suffix}`; }

  get value() { return this.#inputEl.value; }
  set value(v) { this.#inputEl.value = v; }
  set placeholder(v) { this.#inputEl.placeholder = v; }

  #buildDOM() {
    this.node = document.createElement('div');
    this.node.className = this.#cls('wrap');

    this.#inputEl = document.createElement('input');
    this.#inputEl.className = this.#cls('input');
    this.#inputEl.type = 'text';
    this.#inputEl.autocomplete = 'off';
    this.#inputEl.spellcheck = false;

    this.#inputEl.addEventListener('input', () => {
      this.#onChange(this.#inputEl.value);
      this.#open();
    });
    this.#inputEl.addEventListener('focus', () => this.#open());
    // le mousedown sur le dropdown (ci-dessous) fait preventDefault, donc le
    // focus ne quitte jamais l'input pendant une sélection — un reclic sur
    // un input déjà focus ne redéclenche pas 'focus', d'où ce listener 'click'
    this.#inputEl.addEventListener('click', () => this.#open());
    // le blur ne se déclenche que pour un clic vraiment en dehors
    this.#inputEl.addEventListener('blur', () => this.#close());
    this.#inputEl.addEventListener('keydown', e => this.#onKeyDown(e));

    this.#dropdownEl = document.createElement('div');
    this.#dropdownEl.className = this.#cls('dropdown');
    this.#dropdownEl.addEventListener('mousedown', e => e.preventDefault());

    this.#listEl = document.createElement('div');
    this.#listEl.className = this.#cls('list');
    this.#dropdownEl.appendChild(this.#listEl);

    this.node.append(this.#inputEl, this.#dropdownEl);
  }

  #open() {
    this.#renderList();
    this.#position();
    this.#dropdownEl.classList.add('open');
    this.#startTracking();
  }

  #close() {
    this.#dropdownEl.classList.remove('open');
    this.#stopTracking();
  }

  #startTracking() {
    document.addEventListener('scroll', this.#boundReposition, true);
    window.addEventListener('resize', this.#boundReposition);
  }
  #stopTracking() {
    document.removeEventListener('scroll', this.#boundReposition, true);
    window.removeEventListener('resize', this.#boundReposition);
  }

  #position() {
    const rect = this.#inputEl.getBoundingClientRect();
    this.#dropdownEl.style.top   = (rect.bottom + 4) + 'px';
    this.#dropdownEl.style.left  = rect.left + 'px';
    this.#dropdownEl.style.width = rect.width + 'px';
  }

  #renderList() {
    this.#listEl.innerHTML = '';
    this.#items = this.#getList() ?? [];
    this.#activeIndex = -1;
    this.#items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = this.#cls('item');
      row.textContent = item;
      row.addEventListener('mouseenter', () => this.#setActive(i));
      row.addEventListener('click', () => this.#select(item));
      this.#listEl.appendChild(row);
    });
  }

  #select(item) {
    this.#inputEl.value = item;
    this.#onChange(item);
    this.#close();
  }

  #setActive(index) {
    const rows = this.#listEl.children;
    if (this.#activeIndex >= 0 && rows[this.#activeIndex])
      rows[this.#activeIndex].classList.remove('active');
    this.#activeIndex = index;
    const row = rows[index];
    if (row) {
      row.classList.add('active');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  #moveActive(delta) {
    if (!this.#items.length) return;
    const next = Math.min(Math.max(this.#activeIndex + delta, 0), this.#items.length - 1);
    this.#setActive(next);
  }

  #onKeyDown(e) {
    const isOpen = this.#dropdownEl.classList.contains('open');
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) this.#open();
        this.#moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) this.#open();
        this.#moveActive(-1);
        break;
      case 'Enter':
        if (!isOpen) return;
        e.preventDefault();
        if (this.#activeIndex >= 0) this.#select(this.#items[this.#activeIndex]);
        else this.#close();
        break;
      case 'Escape':
        if (!isOpen) return;
        e.preventDefault();
        this.#close();
        break;
    }
  }
}

// ── Exemple d'usage (à titre d'étude) ────────────────────────────────
//
// const packages = ['tlspuffin', 'sshpuffin'];
// const listInput = new ListInput(
//   () => packages,
//   value => console.log('value changed:', value),
//   'jl', // réutilise les classes jl-* de joblauncher.css
// );
// document.body.appendChild(listInput.node);
