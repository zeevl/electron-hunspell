import { Hunspell, HunspellFactory, loadModule } from 'hunspell-asm';
import { log } from './util/logger';

/**
 * @internal
 * Spell checker instance corresponds to each loaded dictionary.
 */
interface SpellChecker {
  spellChecker: Hunspell;
  uptime: number;
  dispose: () => void;
}

/**
 * Naive utility method to lodash.orderBy returns ascending order.
 *
 * [].sort(sortBy('keyToSort'))
 */
const sortBy = (key: string) => (a: object, b: object) => (a[key] > b[key] ? 1 : b[key] > a[key] ? -1 : 0);

/**
 * Provides interface to manage spell checker and corresponding dictionaries, as well as attaching into electron's webFrame.
 */
class SpellCheckerProvider {
  private hunspellFactory: HunspellFactory;
  private spellCheckerTable: { [x: string]: SpellChecker } = {};
  /**
   * Returns array of dictionary keys currently loaded.
   * Array is sorted by usage time of dictionary by descending order.
   */
  public get availableDictionaries(): Readonly<Array<string>> {
    const array = Object.keys(this.spellCheckerTable).map(key => ({ key, uptime: this.spellCheckerTable[key].uptime }));
    //order by key `uptime`, then reverse to descending order
    return array
      .sort(sortBy('uptime'))
      .reverse()
      .map((v: { key: string }) => v.key);
  }

  private _currentSpellCheckerKey: string | null = null;
  /**
   * Returns currently selected dictionary key.
   */
  public get selectedDictionary(): string | null {
    return this._currentSpellCheckerKey;
  }

  private _verboseLog: boolean = false;
  /**
   * Allow to emit more verbose log.
   */
  public set verboseLog(value: boolean) {
    this._verboseLog = value;
  }

  private currentSpellCheckerStartTime: number = Number.NEGATIVE_INFINITY;

  /**
   * Initialize provider.
   *
   */
  public async initialize(initOptions?: Parameters<typeof import('hunspell-asm').loadModule>[0]): Promise<void> {
    if (!!this.hunspellFactory) {
      return;
    }

    log.info(`loadAsmModule: loading hunspell-asm module`);
    this.hunspellFactory = await loadModule(initOptions);
    log.info(`loadAsmModule: asm module loaded successfully`);
  }

  /**
   * Set current spell checker instance for given locale key then attach into current webFrame.
   * @param {string} key Locale key for spell checker instance.
   */
  public switchDictionary(key: string): void {
    if (!key || !this.spellCheckerTable[key]) {
      throw new Error(`Spellchecker dictionary for ${key} is not available, ensure dictionary loaded`);
    }

    log.info(
      `switchDictionary: switching dictionary to check spell from '${this._currentSpellCheckerKey}' to '${key}'`
    );

    if (Number.isInteger(this.currentSpellCheckerStartTime)) {
      const timePassed = Date.now() - this.currentSpellCheckerStartTime;
      const currentKey = this._currentSpellCheckerKey;
      if (!!currentKey) {
        this.spellCheckerTable[currentKey].uptime += timePassed;
        log.info(`switchDictionary: total uptime for '${currentKey}' - '${this.spellCheckerTable[currentKey].uptime}'`);
      }
    }

    this.currentSpellCheckerStartTime = Date.now();
    this._currentSpellCheckerKey = key;
    this.attach(key);
  }

  /**
   * Get suggestion for misspelled text.
   * @param {string} Text text to get suggstion.
   * @returns {Readonly<Array<string>>} Array of suggested values.
   */
  public getSuggestion(text: string): Readonly<Array<string>> {
    if (!this._currentSpellCheckerKey) {
      log.warn(`getSuggestedWord: there isn't any spellchecker key, bailing`);
      return [];
    }

    const checker = this.spellCheckerTable[this._currentSpellCheckerKey];
    if (!checker) {
      log.error(`attach: There isn't corresponding dictionary for key '${this._currentSpellCheckerKey}'`);
      return [];
    }

    const ret = checker.spellChecker.suggest(text);
    if (this._verboseLog) {
      log.debug(`getSuggestion: '${text}' got suggestions`, ret);
    }
    return ret;
  }

  /**
   * Load specified dictionary into memory, creates hunspell instance for corresponding locale key.
   * @param {string} languageKey Locale key for spell checker instance.
   * @param {ArrayBufferView} ArrayBufferView for dictionary content.
   * @param {ArrayBufferView} ArrayBufferView for affix content.
   * @returns {Promise<void>} Indication to load completes.
   */
  public async loadDictionary(
    languageKey: string,
    dicBuffer: ArrayBufferView,
    affBuffer: ArrayBufferView
  ): Promise<void> {
    if (!languageKey || !!this.spellCheckerTable[languageKey]) {
      throw new Error(`Invalid key: ${!!languageKey ? 'already registered key' : 'key is empty'}`);
    }

    const isBufferDictionary = ArrayBuffer.isView(dicBuffer) && ArrayBuffer.isView(affBuffer);

    if (!isBufferDictionary) {
      throw new Error('Cannot load dictionary for given parameters');
    }

    const factory = this.hunspellFactory;
    this.createSpllcheckerInstanceForLanguage(
      languageKey,
      factory.mountBuffer(affBuffer),
      factory.mountBuffer(dicBuffer)
    );
  }

  /**
   * Dispose given spell checker instance and unload dictionary from memory.
   * @param {string} languageKey Locale key for spell checker instance.
   */
  public unloadDictionary(languageKey: string): void {
    if (!languageKey || !this.spellCheckerTable[languageKey]) {
      log.info(`unloadDictionary: not able to find corresponding spellchecker for given key`);
      return;
    }

    if (!!this._currentSpellCheckerKey && this._currentSpellCheckerKey === languageKey) {
      this._currentSpellCheckerKey = null;
      this.currentSpellCheckerStartTime = Number.NEGATIVE_INFINITY;

      log.warn(`unloadDictionary: unload dictionary for current spellchecker instance`);
      this.setProvider(languageKey, () => true);
    }

    const dict = this.spellCheckerTable[languageKey];
    dict.dispose();

    delete this.spellCheckerTable[languageKey];
    log.info(`unloadDictionary: dictionary for '${languageKey}' is unloaded`);
  }

  private attach(key: string): void {
    const checker = this.spellCheckerTable[key];

    const provider = (text: string) => {
      const ret = checker.spellChecker.spell(text);
      if (this._verboseLog) {
        log.debug(`spellChecker: checking spell for '${text}' with '${key}' returned`, ret);
      }
      return ret;
    };
    this.setProvider(key, provider);
  }

  private setProvider(key: string, provider: (text: string) => boolean): void {
    const webFrame: typeof import('electron').webFrame | null =
      process.type === 'renderer' ? require('electron').webFrame : null; //tslint:disable-line:no-var-requires no-require-imports

    if (!webFrame) {
      log.warn(`attach: Cannot lookup webFrame to set spell checker provider`);
      return;
    }

    webFrame.setSpellCheckProvider(key, true, { spellCheck: provider });
  }

  /**
   * Create hunspell-asm instance, assign into inner table for lookup.
   */
  private createSpllcheckerInstanceForLanguage(languageKey: string, affMountPath: string, dicMountPath: string) {
    const factory = this.hunspellFactory;
    const spellChecker = factory.create(affMountPath, dicMountPath);

    /**
     * Unmount virtual file created from arraybuffer, dispose spellchecker instance
     */
    const dispose = () => {
      factory.unmount(affMountPath);
      factory.unmount(dicMountPath);
      log.debug(`unmountBuffer: unmounted buffer `, affMountPath, dicMountPath);

      spellChecker.dispose();
      log.debug(`unmountBuffer: disposed hunspell instance for `, languageKey);
    };

    this.spellCheckerTable[languageKey] = {
      uptime: 0,
      spellChecker,
      dispose: dispose
    };

    log.info(`assignSpellchecker: spellCheckerTable added new checker for '${languageKey}'`);
  }
}

export { SpellCheckerProvider };
