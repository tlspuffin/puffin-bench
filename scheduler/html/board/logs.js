class Logs {
  #abortCtrl;
  #currentID;
  #step;
  #type;
  #infos;

  constructor() {
    this.#ResetStates();
  }

  async Show(step, taskName) {
    this.#abortCtrl?.abort();

    const id = step.task_id + '-' + step.uuid;
    if (id != this.#currentID) {
      this.#ResetStates(step);
    }
    const signal = this.#abortCtrl.signal;

    let stepName = this.#step.name;
    if ((this.#step.id != '') && (this.#step.id != '.')) {
      stepName += ` ${this.#step.id}`;
    }
    stepName += ` (${taskName})`;

    document.getElementById(`log-${this.#type}`).classList.add('active');
    document.getElementById(`${this.#type}-container`).classList.add('active');
    document.getElementById(`${this.#type}-content`).classList.add('active');
    let inactiveType = this.#type === 'stdout' ? 'stderr' : 'stdout';
    document.getElementById(`log-${inactiveType}`).classList.remove('active');
    document.getElementById(`${inactiveType}-container`).classList.remove('active');
    document.getElementById(`${inactiveType}-content`).classList.remove('active');

    document.getElementById('step-name').innerText = stepName;
    document.getElementById('logs-modal').classList.add('show');

    let loop = null;
    do {
      loop = await this.#GetLogs(signal, 1024*1024);
      if (signal.aborted) {
        return;
      }
    } while (loop[0] && loop[1]);

    const div = document.getElementById('stdout-content');
    const [cols, rows] = this.#SizeInfo(div);
    console.log(cols, rows);
    /*let msg = '';*/
    /*for(let i=0; i<rows; ++i) {
      for(let j=0; j<cols; ++j) {
        msg += i != (rows-1) ? (j != (cols-1) ? '.' : 'x') : (j != (cols-1) ? '!' : 'X');
      }
    }*/

    let nbChars = 0;
    let nbRows = 0;
    let offset = 0;
    for(let i=(this.#infos[this.#type].data.length - 1); i>=0; --i) {
      if (this.#infos[this.#type].data[i] == '\n') {
        ++nbRows;
        nbChars = 0;
      } else {
        ++nbChars;
        if (nbChars == cols) {
          ++nbRows;
          nbChars = 0;
        }
      }
      if (nbRows >= rows) {
        offset = i;
        break;
      }
    }

    const text = this.#infos[this.#type].data.substring(offset, this.#infos[this.#type].data.length-1);
    div.innerText = text;
  }

  #ResetStates(step) {
    this.#abortCtrl = new AbortController();
    this.#step = step;
    this.#type = 'stdout'
    this.#infos = {
      'stdout' : {
        'state': '',
        'offset': 0,
        'decoder': new TextDecoder("utf-8"),
        'data': ''
      },
      'stderr' : {
        'state': '',
        'offset': 0,
        'decoder': new TextDecoder("utf-8"),
        'data': ''
      }
    }
    if (this.#step != null) {
      this.#currentID = this.#step.task_id + '-' + this.#step.uuid;
    } else {
      this.#currentID = null;
    }
  }

  async #GetLogs(signal, size) {
    const taskID = this.#step.task_id;
    const stepUUID = this.#step.uuid;
    const stepID = this.#step.step_id + '-' + this.#step.rank_id + '-' + this.#step.attempt_id;

    const type = this.#type;

    var response = await fetch(
        `http://${window.location.host}/api/task/output/${taskID}/${stepUUID}/${stepID}/${type}/${size}/${this.#infos[type].offset}`);

    if ((!response.ok) || signal.aborted) {
      return [false, null];
    }
    var data = await response.json();
    if ((!data.success) || signal.aborted) {
      return [false, null];
    }

    this.#infos[type].state = data.state;
    this.#infos[type].offset += data.size;
    const streamMore = (this.#infos[type].offset != data.filesize) && (data.state != 2);
    this.#infos[type].data += this.#infos[type].decoder.decode(
        Uint8Array.from(atob(data.data), c => c.charCodeAt(0)), 
        { stream: streamMore });

    return [true, streamMore];
  }

  #SizeInfo(div) {
    const style = getComputedStyle(div);
    const width = div.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);;
    const height = div.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    const charWidth = ctx.measureText('M').width;
    const charHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const cols = Math.floor(width / charWidth);
    const rows = Math.floor(height / charHeight);
    return [cols, rows];
  }

};

const Logger = new Logs();

export { Logger };
