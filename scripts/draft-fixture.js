// 仅供离线浏览器回归的最小不可变 Draft 模型，不随扩展运行。
(() => {
  function List(values = []) { if (!(this instanceof List)) return new List(values); this.values = [...values]; this.size = this.values.length; }
  List.prototype.forEach = function (fn) { this.values.forEach(fn); };
  List.prototype.find = function (fn) { return this.values.find(fn); };
  List.prototype.get = function (i) { return this.values[i]; };
  List.prototype.first = function () { return this.values[0]; };
  List.prototype.clear = function () { return List(); };
  List.prototype.push = function (v) { return List([...this.values, v]); };
  List.prototype.concat = function (v) { return List([...this.values, ...v]); };
  List.prototype.toJS = function () { return this.values.map(v => v?.toJS?.() || v); };
  function BlockMap(entries = []) { if (!(this instanceof BlockMap)) return new BlockMap(entries); this.entries = [...entries]; }
  BlockMap.prototype.forEach = function (fn) { for (const [key, block] of this.entries) { if (fn(block, key) === false) break; } };
  BlockMap.prototype.find = function (fn) { return this.entries.find(([, block]) => fn(block))?.[1]; };
  BlockMap.prototype.get = function (key) { return this.entries.find(([k]) => k === key)?.[1]; };
  BlockMap.prototype.last = function () { return this.entries.at(-1)?.[1]; };
  BlockMap.prototype.set = function (key, block) { const entries = this.entries.map(e => [...e]); const index = entries.findIndex(([k]) => k === key); if (index < 0) entries.push([key, block]); else entries[index] = [key, block]; return BlockMap(entries); };
  BlockMap.prototype.delete = function (key) { return BlockMap(this.entries.filter(([k]) => k !== key)); };
  class Style { constructor(values = []) { this.values = values; } clear() { return new Style(); } add(v) { return new Style([...this.values, v]); } toJS() { return this.values; } }
  class Character { constructor(entity = null, style = new Style()) { this.entity = entity; this.style = style; } getStyle() { return this.style; } getEntity() { return this.entity; } set(key, value) { return new Character(key === 'entity' ? value : this.entity, key === 'style' ? value : this.style); } toJS() { return { entity: this.entity, style: this.style.toJS() }; } static create() { return new Character(); } }
  class Data { clear() { return new Data(); } toJS() { return {}; } }
  class Block {
    constructor({ key = 'original', type = 'unstyled', text = '原正文', characterList, depth = 0, data = new Data() } = {}) { Object.assign(this, { key, type, text, characterList: characterList || List(Array.from(text, () => new Character())), depth, data }); }
    getKey() { return this.key; } getText() { return this.text; } getType() { return this.type; } getDepth() { return this.depth; } getData() { return this.data; } getCharacterList() { return this.characterList; }
    merge(patch) { return new Block({ ...this, ...patch }); }
    findEntityRanges(predicate, fn) { this.characterList.values.forEach((c, i) => { if (predicate(c)) fn(i, i + 1); }); }
  }
  class Content {
    constructor(blocks = BlockMap([['original', new Block()]]), entities = {}, last = null) { this.blocks = blocks; this.entities = entities; this.last = last; }
    getBlockMap() { return this.blocks; } getPlainText() { return this.blocks.entries.map(([, b]) => b.text).join('\n'); }
    getEntity(k) { return this.entities[k]; } getLastCreatedEntityKey() { return this.last; }
    createEntity(type, mutability, data) { const key = String(Object.keys(this.entities).length); const entity = { getType: () => type, getData: () => data }; return new Content(this.blocks, { ...this.entities, [key]: entity }, key); }
    set(key, value) { return key === 'blockMap' ? new Content(value, this.entities, this.last) : this; }
  }
  class Selection { static createEmpty(key) { return new Selection(key); } constructor(key) { this.key = key; } merge(values) { return Object.assign(new Selection(this.key), this, values); } }
  class EditorState {
    constructor(content, selection = new Selection('original')) { this.content = content; this.selection = selection; }
    getCurrentContent() { return this.content; } getSelection() { return this.selection; }
    static push(state, content) { return new EditorState(content, state.selection); }
    static moveSelectionToEnd(state) { return state; }
    static forceSelection(state, selection) { return new EditorState(state.content, selection); }
  }
  let node;
  function render() { document.querySelector('.public-DraftEditor-content').textContent = node.props.editorState.getCurrentContent().getPlainText(); }
  function install(text = '原正文', options = {}) {
    const block = new Block({ text });
    node = { props: { editorState: new EditorState(new Content(BlockMap([[block.key, block]]))), onChange(state) { node.props.editorState = state; render(); options.onChange?.(state); }, onFilesAdded() {
      window.fixtureUploading = true;
      setTimeout(() => {
        const old = node.props.editorState; let content = old.getCurrentContent(); const key = old.getSelection().key;
        const marker = content.getBlockMap().get(key);
        content = content.createEntity('MEDIA', 'IMMUTABLE', { mediaItems: [{ mediaId: '987654321' }] });
        const next = marker.merge({ type: 'atomic', text: ' ', characterList: List([new Character(content.getLastCreatedEntityKey())]) });
        node.props.onChange(EditorState.push(old, content.set('blockMap', content.getBlockMap().set(key, next))));
      }, options.uploadDelay || 500);
    } } };
    const editor = document.querySelector('.public-DraftEditor-content');
    editor.__reactFiber$fixture = { stateNode: node };
    editor.oninput = () => external(editor.textContent);
    render(); window.fixtureUploading = false;
  }
  function external(text) { const state = node.props.editorState; const blocks = state.content.blocks; const key = blocks.entries.find(([, b]) => b.type !== 'atomic')?.[0]; if (!key) return; const block = blocks.get(key).merge({ text, characterList: List(Array.from(text, () => new Character())) }); node.props.editorState = EditorState.push(state, state.content.set('blockMap', blocks.set(key, block))); render(); }
  window.testDraft = { install, external, node: () => node };
})();
