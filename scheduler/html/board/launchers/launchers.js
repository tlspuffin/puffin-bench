import { config } from './config.js';

const link = document.createElement('link');
link.rel  = 'stylesheet';
link.href = new URL('./launchers.css', import.meta.url);
document.head.appendChild(link);

const mods = await Promise.all(config.projects.map(p => import(`./${p}/joblauncher.js`)));
export const launchers = mods.map((m, i) => {
  const instance = new m.JobLauncher();
  return { label: config.projects[i], open: () => instance.open() };
});

const menu = document.createElement('div');
menu.className = 'launcher-menu';
for (const entry of launchers) {
  const item = document.createElement('button');
  item.className = 'launcher-menu-item';
  item.textContent = entry.label;
  item.addEventListener('click', () => {
    menu.remove();
    entry.open();
  });
  menu.appendChild(item);
}

function ShowLauncherMenu(event) {
  if (launchers.length === 1) { 
    launchers[0].open();
    return;
  }

  if (menu.isConnected) { 
    menu.remove(); 
    return;
  }

  const rect = nextTaskBt.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  menu.style.right  = (window.innerWidth - rect.right) + 'px';

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', function onOutside(e) {
    if (!menu.contains(e.target) && e.target !== nextTaskBt) {
      menu.remove();
      document.removeEventListener('click', onOutside);
    }
  }), 0);
}

const nextTaskBt = document.createElement('button');
nextTaskBt.id = 'new-task';
nextTaskBt.classList.add('new-task');
nextTaskBt.innerText = '+';
nextTaskBt.onclick = ShowLauncherMenu;
document.body.appendChild(nextTaskBt);