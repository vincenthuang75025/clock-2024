import { Component, OnInit } from '@angular/core';
import { ConfirmationService, MenuItem, MessageService, PrimeNGConfig } from 'primeng/api';
import { abs, floor, max, min, mod, mod2 } from '@tubular/math';
import {
  extendDelimited, forEach, getCssValue, isAndroid, isEqual, isLikelyMobile, isMacOS, isObject, isSafari, noop,
  processMillis
} from '@tubular/util';
import { AngleStyle, DateTimeStyle, TimeEditorOptions } from '@tubular/ng-widgets';
import {
  AstroEvent, EventFinder, FALL_EQUINOX, FIRST_QUARTER, FULL_MOON, JUPITER, LAST_QUARTER, MARS, MERCURY, MOON,
  NEW_MOON, RISE_EVENT, SATURN, SET_EVENT, SkyObserver, SPRING_EQUINOX, SUMMER_SOLSTICE, SUN, TRANSIT_EVENT, VENUS,
  WINTER_SOLSTICE
} from '@tubular/astronomy';
import ttime, { DateAndTime, DateTime, Timezone } from '@tubular/time';
import { Globe } from '../globe/globe';
import { basePath, languageList, SOUTH_NORTH, specificLocale, WEST_EAST } from '../locales/locale-info';
import { faForward, faPlay, faStop } from '@fortawesome/free-solid-svg-icons';
import {
  adjustForEclipticWheel, AngleTriplet, BasicPositions, calculateBasicPositions,
  MILLIS_PER_DAY, MILLIS_PER_SIDEREAL_DAY, solarSystem, ZeroAngles
} from 'src/math/math';
import { adjustGraphicsForLatitude, initSvgHost, sunlitMoonPath, SvgHost } from 'src/svg/svg';
import { sizeChanges } from '../main';
import { Subscription, timer } from 'rxjs';

const { DATETIME_LOCAL, julianDay, TIME } = ttime;

const CLICK_REPEAT_DELAY = 500;
const CLICK_REPEAT_RATE  = 100;

const RESUME_FILTERING_DELAY = 1000;
const SIMPLE_FILTER_IS_SLOW_TOO = isAndroid() || (isSafari() && isMacOS());
const STOP_FILTERING_DELAY = SIMPLE_FILTER_IS_SLOW_TOO ? 1000 : 3000;
const START_FILTERING_DELAY = SIMPLE_FILTER_IS_SLOW_TOO ? 1000 : 500;

enum EventType { EQUISOLSTICE, MOON_PHASE, RISE_SET }
enum PlaySpeed { NORMAL, FAST }

const prague = $localize`Prague, CZE`;
const pragueLat = 50.0870;
const pragueLon = 14.4185;

const defaultSettings = {
  additionalPlanets: false,
  animateBySiderealDays: false,
  appearance: 0,
  background: '#4D4D4D',
  collapsed: false,
  detailedMechanism: false,
  disableDst: true,
  eventType: EventType.EQUISOLSTICE,
  fasterGraphics: true,
  isoFormat: false,
  latitude: pragueLat,
  longitude: pragueLon,
  placeName: prague,
  realPositionMarkers: false,
  recentLocations: [{
    lastTimeUsed: 0,
    latitude: pragueLat,
    longitude: pragueLon,
    name: prague,
    zone: 'Europe/Prague'
  }],
  showInfoPanel: false,
  suppressOsKeyboard: false,
  timing: 0,
  trackTime: true,
  translucentEcliptic: false,
  zone: 'Europe/Prague'
};

function basicPosKey(key: string): boolean { return !key.startsWith('_'); }

function formatTimeOfDay(hours: number | DateTime | DateAndTime, force24 = false, zeroIs24 = false): string {
  if (hours instanceof DateTime)
    hours = hours.wallTime;

  if (isObject(hours))
    hours = hours.hour + hours.minute / 60;

  const minutes = min(floor(hours * 60 + 0.001), 1439);
  const hour = floor(minutes / 60);
  const minute = minutes % 60;
  const format = force24 ? TIME : 'IxS{hour:2-digit}';
  let time = new DateTime([1970, 1, 1, hour, minute], 'UTC', specificLocale).format(format);

  if (zeroIs24)
    time = time.replace(/^00/, '24');

  return time;
}

const menuLanguageList: MenuItem[] = [];
const smallMobile = isLikelyMobile() && (screen.width < 460 || screen.height < 460);

menuLanguageList.push({ label: $localize`Default`, url: basePath, target: '_self' });
menuLanguageList.push({ separator: true });
languageList.forEach(language =>
  menuLanguageList.push({ label: language.name, url: basePath + language.directory, target: '_self' }));

interface DateImage {
  date: Date;
  title: string;
  description?: string;
  imageUrl?: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, SvgHost {
  faForward = faForward;
  faPlay = faPlay;
  faStop = faStop;

  CURRENT = 0;
  DD = AngleStyle.DD;
  DDD = AngleStyle.DDD;
  FAST = PlaySpeed.FAST;
  MODERN = 0;
  MAX_YEAR = 2399;
  menuLanguageList = menuLanguageList;
  MIN_YEAR = 1400;
  NORMAL = PlaySpeed.NORMAL;
  smallMobile = smallMobile;
  SOUTH_NORTH = SOUTH_NORTH;
  specificLocale = specificLocale;
  toZodiac = (angle: number): string => '♈♉♊♋♌♍♎♏♐♑♒♓'.charAt(floor(mod(angle, 360) / 30)) + '\uFE0E';
  WEST_EAST = WEST_EAST;

  LOCAL_OPTS: TimeEditorOptions = {
    dateTimeStyle: DateTimeStyle.DATE_AND_TIME,
    locale: specificLocale,
    twoDigitYear: false,
    showDstSymbol: true,
    showSeconds: false
  };

  ISO_OPTS = ['ISO', this.LOCAL_OPTS, { showUtcOffset: true }];

  private _additionalPlanets = false;
  private _appearance = 0;
  private _background = '#4D4D4D';
  private _collapsed = false;
  private delayedCollapse = false;
  private eventClickTimer: Subscription;
  private eventFinder = new EventFinder();
  private eventGoBack = false;
  private eventType = EventType.EQUISOLSTICE;
  private globe: Globe
  private graphicsChangeLastTime = -1;
  private graphicsChangeStartTime = -1;
  private graphicsChangeStopTimer: any;
  private initDone = false;
  private _isoFormat = false;
  private lastSavedSettings: any = null;
  private lastWallTime: DateAndTime;
  private _latitude = pragueLat;
  private _longitude = pragueLon;
  private localTimezone = Timezone.getTimezone('LMT', this._longitude);
  private observer: SkyObserver;
  private _playing = false;
  private playTimeBase: number;
  private playTimeProcessBase: number;
  private _realPositionMarkers = false;
  private _showInfoPanel = false;
  private sunsetA: AstroEvent = null;
  private sunsetB: AstroEvent = null;
  private _suppressOsKeyboard = false;
  private _time = 0;
  private timeCheck: any;
  private _timing = 0;
  private timingReference: BasicPositions | null | undefined;
  private _trackTime = false;
  private _zone = 'Europe/Prague';
  private zoneFixTimeout: any;

  menuItems: MenuItem[] = [];

  // This trick is need to be able to access SvgHost fields which are not explicitly declared here.
  self: AppComponent & SvgHost = this;

  altFour = false;
  animateBySiderealDays = false;
  bohemianTime = '';
  canEditName = false;
  canSaveName = false;
  dawnDuskFontSize = '15px';
  dawnTextOffset: number;
  detailedMechanism = false;
  disableDst = true;
  dstChangeAllowed = true;
  emptyCenter = false;
  errorMoon = 0;
  errorMoonDays = 0;
  errorPhase = 0;
  errorPhaseDays = 0;
  errorSun = 0;
  errorSunMinutes = 0;
  fasterGraphics = true;
  handAngle = 0;
  inputLength = 0;
  inputName: string;
  jupiterAngle = ZeroAngles;
  lastHeight = -1;
  lastRecalibration = '';
  localMeanTime = '';
  localSolarTime = '';
  localTime = '';
  marsAngle = ZeroAngles;
  mercuryAngle = ZeroAngles;
  moonAngle = ZeroAngles;
  moonHandAngle = 0;
  moonPhase = 0;
  moonrise = '';
  moonset = '';
  outerRingAngle = 0;
  outerSunriseAngle: number = null;
  overlapShift = [0, 0, 0, 0, 0];
  placeName = 'Prague, CZE';
  playSpeed = PlaySpeed.NORMAL;
  recentLocations: any[] = [];
  rotateSign = 1;
  saturnAngle = ZeroAngles;
  showAllErrors = false;
  showErrors = false;
  showLanguageMenu = false;
  showRecalibration = false;
  siderealAngle = 0;
  siderealTime = '';
  siderealTimeOrloj = '';
  sunAngle = ZeroAngles;
  sunrise: string;
  sunset: string;
  svgFilteringOn = true;
  timeText = '';
  translucentEcliptic = false;
  true_handAngle = 0;
  true_moonAngle = ZeroAngles;
  true_moonHandleAngle = 0;
  true_moonPhase = 0;
  true_siderealAngle = 0;
  true_sunAngle = ZeroAngles;
  venusAngle = ZeroAngles;
  zoneOffset = '';

  private stoppedDates: Set<string> = new Set();

  private STOP_DATE_IMAGES: DateImage[] = [
    {
      date: new Date(2024, 0, 5), // January 5th
      title: 'crashed the JMM conference',
      description: "saw my math friends and sat in on a talk by Terence Tao. it was the best explanation of difficult math i've ever heard - i think it's because he is constantly aware of the exact right level of abstraction to explain new concepts at",
      imageUrl: 'assets/0105-jmm.jpg',
    },
    {
      date: new Date(2024, 1, 2), // February 2nd
      title: 'finally feeling competent with LLMs',
      description: "it took me 6 months of work to really feel like i understood how to do stuff - i had to write a trainer with 3d parallelism to finally get it. doing so also made me realize that a shocking number of people who work in AI don't understand pretraining",
      imageUrl: 'assets/0202-llm.png',
    },
    {
      date: new Date(2024, 1, 12), // February 12th
      title: 'birthday surprises!',
      description: 'so many surprises this year!! A got me a cat lamp, S made a website inspired by one of my blogs, and i was also ambushed at a Chinese New Year party. i love friends <3',
      imageUrl: 'assets/0212-bday.png',
    },
    {
      date: new Date(2024, 1, 16), // February 16th
      title: 'finished reading NVC',
      description: 'part of a longer-term communication overhaul that started in late 2023 (i wanted to avoid repeating mistakes i made during a breakup)',
      imageUrl: 'assets/0216-nvc.png',
    },
    {
      date: new Date(2024, 1, 20), // February 20th
      title: "saw my friends' production of 'Tick, Tick... Boom!'",
      description: "stage version is way better than the movie. really great portrayal of artistic anxiety",
      imageUrl: 'assets/0220-ttb.png'
    },
    {
      date: new Date(2024, 2, 2), // March 2nd
      title: "moved into new house with friends!!",
      description: "assembled lots of chairs, spent a week looking for non-fiberglass mattresses, became plant caretaker, watched Marley eat cheese",
      imageUrl: 'assets/0302-house.png'
    },
    {
      date: new Date(2024, 2, 9), // March 9th
      title: "tried Waymo for the first time!",
      description: "feels a bit absurd, like you're using your phone to summon a 3000-pound metal pokemon",
      imageUrl: 'assets/0309-waymo.png'
    },
    {
      date: new Date(2024, 3, 8), // April 8th
      title: "SAW THE TOTAL ECLIPSE!!!",
      description: "fun fact: most total eclipses have already happened, as the moon is slowly moving away from the earth and will eventually be too far away to cover the sun\nfun fact 2: if you're on slow mode, you can see the eclipse happen on the astronomical clock, down to the hour! (keeping in mind that the clock shows Prague time without daylight savings)",
      imageUrl: 'assets/0408-eclipse.png'
    },
    {
      date: new Date(2024, 4, 18), // May 18th
      title: 'road trip to South Dakota',
      description: 'fought my fear of heights',
      imageUrl: 'assets/0518-notch.png'
    },
    {
      date: new Date(2024, 5, 25), // June 25th
      title: 'wrote (with coworkers) a blog post on how to set up clusters for LLM pretraining',
      description: "my friends at compute/infra companies tell me this blog post is now required onboarding material for them, which is hilarious as we're not even an infra company",
      imageUrl: 'assets/0625-infra.png'
    },
    {
      date: new Date(2024, 6, 19), // July 19th
      title: 'tried shrooms^ for the first time',
      description: "with my best friend A who happened to be visiting! went much better than expected - i thought i would be anxious but the anxiety never materialized and instead i laughed so much my abs hurt for days afterwards\n\nrealized 2 things:\n1) many of my problems stem from overthinking about the future. when i stop thinking about the future it genuinely feels like problems don't exist \n2) when i encounter obstacles my instinct is to try harder and power through them, but oftentimes the obstacle is a sign that i should be taking a different approach entirely\n\n\n^for legal reasons this refers to oyster mushrooms"
    },
    {
      date: new Date(2024, 6, 31), // July 31st
      title: 'invented lunge circle',
      description: "lunges except you go harder because of social pressure!\nunfortunately i have no pictures of real lunge circle so you're getting the meme version",
      imageUrl: 'assets/0731-lunge.png'
    },
    {
      date: new Date(2024, 7, 18), // August 18th
      title: 'brain hack!',
      description: 'left Imbue to go play with tofu and Orbeez for a week. also learned some physics and saw good mech-e up close for the first time',
      imageUrl: 'assets/0818-brain.png'
    },
    {
      date: new Date(2024, 7, 20), // August 20th
      title: 'dyed hair!',
      description: "i came from an environment where dyeing was very common (MIT) and didn't realize how uncommon it is in SF until dyeing myself",
      imageUrl: 'assets/0820-hair.png'
    },
    {
      date: new Date(2024, 8, 5), // September 5th
      title: 'finally saw Wicked after like 9 years of waiting',
      description: 'stage effects were pretty cool and For Good is still one of my favorite songs',
      imageUrl: 'assets/0905-wicked.png'
    },
    {
      date: new Date(2024, 8, 16), // September 16th
      title: 'started going to dance classes',
      description: "i don't have much to say on this other than that i think it's good for the soul to regularly do an activity that you enjoy while being bad at it. otherwise you literally start to forget that you can try and enjoy things as a beginner",
    },
    {
      date: new Date(2024, 8, 30), // September 30th
      title: 'my first real research contribution!',
      description: "figured out how to attribute language model outputs to individual neurons, allowing us to understand problems like '9.8 < 9.11'. prior to this we'd been trying to steer models for months without success because we couldn't identify the right set of neurons to intervene on",
      imageUrl: 'assets/0930-steer.png'
    },
    {
      date: new Date(2024, 9, 22), // October 22nd
      title: 'Transluce launch day!',
      description: 'stayed up until 6 getting deployments ready with Kevin! very exhilirating, felt like a hackathon except actually useful. also my first time using a lot of tech - Cloudflare, Modal, Gunicorn, Posthog, etc.',
      imageUrl: 'assets/1022-transluce.png',
    },
    {
      date: new Date(2024, 9, 25), // October 25th
      title: "THANK GOD I CAN GET OFF THIS TRAIN I'VE BEEN STUCK ON FOR THE LAST 60 HOURS",
      description: "took the California Zephyr from SF to Chicago. incredibly scenic (especially Utah + Colorado) but gross bathrooms and brutal delays due to engine failures",
      imageUrl: 'assets/1025-train.jpg'
    },
    {
      date: new Date(2024, 9, 30), // October 30th
      title: 'talked to Sam Altman',
      description: "he really forces you to grapple with 'what if we succeed', which i (and many other smart friends) have been avoiding thinking seriously about",
      imageUrl: 'assets/1030-sama.png'
    },
    {
      date: new Date(2024, 10, 5), // November 5th
      title: 'visited the Netherlands',
      description: "saw the Markthal in Rotterdam. it felt truly absurd - they built this incredibly dramatic structure and then decided to put an ordinary food court in the lobby",
      imageUrl: 'assets/1105-markthal.jpg'
    },
    {
      date: new Date(2024, 10, 13), // November 13th
      title: 'new favorite picture of myself?',
      description: "S sent me a drawing, and then multiple friends said they could tell it was me based on how i hold plushies <3",
      imageUrl: 'assets/1113-plush.jpg',
    },
    {
      date: new Date(2024, 10, 15), // November 15th
      title: 'A asked me to narrate my life to them',
      description: "we covered most of the important stuff in 4-5 hours? it was a very interesting experience, would recommend trying. helped me uncover patterns that i didn't realize existed, eg:\n\n1) the origins of my insecure attachment and associated beliefs\n2) how SPARC made me good at talking to a very specific kind of person even though i was still bad at talking to everyone else\n3) how i became productivity-pilled but for the wrong reasons\n\nand i think we often tell ourselves unfaithful narratives of the past and restating them to close friends can help remove some of the distortion",
    },
    {
      date: new Date(2024, 10, 16), // November 16th
      title: 'went to Prague!',
      description: "saw many things, most notably the castle, cathedral, and astronomical clock. i think it's kind of incredible how accurately they were tracking and reconstructing solar and lunar movements in ~1400? also saw their independence day celebrations, which are much more festive than the 4th of July",
      imageUrl: 'assets/1116-clock.png',
    },
    {
      date: new Date(2024, 10, 20), // November 20th
      title: "SAW THE MOST GORGEOUS BUILDING OF ALL TIME",
      description: "the Budapest House of Music was actually so astonishingly beautiful that i thought about it for two days straight like just look at the high glass walls and forest-inspired roof! and the interior is a cool music museum where they give you a headset that tracks your location and plays the relevant music for whatever display you're looking at",
      imageUrl: 'assets/1120-buda.jpg'
    },
    {
      date: new Date(2024, 11, 6), // December 6th
      title: 'Interstellar 10th anniverary IMAX release!',
      description: "hits so hard when the screen takes up your entire field of view and the speakers shake the room. felt like i could dream bigger afterwards (photo not mine)",
      imageUrl: 'assets/1206-interstellar.png'
    },
    {
      date: new Date(2024, 11, 13), // December 13th
      title: "visited Neurips",
      description: "nice to see all my AI friends in one place. most talks were not very good, but Ilya's Test of Time talk was interesting - i still find it remarkable that his paper 10 years ago predicted scaling laws, pretraining, and the success of autoregressive models at a time when transformers hadn't even been invented yet",
      imageUrl: 'assets/1213-ilya.png'
    },
  ];

  private STOP_DATES = this.STOP_DATE_IMAGES.map(item => ({
    year: item.date.getFullYear(),
    month: item.date.getMonth() + 1, // Adding 1 since getMonth() is 0-based
    day: item.date.getDate()
  }));

  getStopDateImage(): string | null {
    const clockDate = new DateTime(this.time).toDate();
    const matchingDate = this.STOP_DATE_IMAGES.find(item => 
      item.date.getDate() === clockDate.getDate() &&
      item.date.getMonth() === clockDate.getMonth() &&
      item.date.getFullYear() === clockDate.getFullYear()
    );
    
    return matchingDate ? matchingDate.imageUrl : null;
  }

  getStopDateTitle(): string | null {
    const clockDate = new DateTime(this.time).toDate();
    const matchingDate = this.STOP_DATE_IMAGES.find(item => 
      item.date.getDate() === clockDate.getDate() &&
      item.date.getMonth() === clockDate.getMonth() && 
      item.date.getFullYear() === clockDate.getFullYear()
    );
    
    return matchingDate ? matchingDate.title : null;
  }

  getStopDateDescription(): string | null {
    const clockDate = new DateTime(this.time).toDate();
    const matchingDate = this.STOP_DATE_IMAGES.find(item => 
      item.date.getDate() === clockDate.getDate() &&
      item.date.getMonth() === clockDate.getMonth() &&
      item.date.getFullYear() === clockDate.getFullYear()
    );
    
    return matchingDate ? matchingDate.description : null;
  }

  get filterEcliptic(): string {
    return this.fasterGraphics && (!this.svgFilteringOn || this.playing) ? null : 'url("#filterEcliptic")';
  }

  get filterHand(): string {
    return this.fasterGraphics && (!this.svgFilteringOn || this.playing) ? null : 'url("#filterHand")';
  }

  get filterRelief(): string {
    return this.fasterGraphics && (!this.svgFilteringOn || this.playing) ?
      (SIMPLE_FILTER_IS_SLOW_TOO ? null : 'url("#filterReliefSimple")') : 'url("#filterRelief")';
  }

  constructor(
    private confirmService: ConfirmationService,
    private messageService: MessageService,
    private primeNgConfig: PrimeNGConfig
  ) {
    initSvgHost(this);

    let settings: any;

    try {
      settings = JSON.parse(localStorage.getItem('pac-settings') ?? 'null');

      if (settings?.recentLocations && settings.recentLocations.length > 0) {
        delete settings.constrainedSun;
        settings.recentLocations.forEach((loc: any) => { loc.name = loc.name || loc.placeName; delete loc.placeName; });
        settings.recentLocations[0].name = prague;
      }

      if (settings.post2018 != null) {
        settings.appearance = 0;
        delete settings.appearance;
      }

      delete settings.hideMap;
      delete settings.equatorialPositionMarkers;
    }
    catch {
      settings = null;
    }

    settings = settings ?? defaultSettings;
    Object.keys(defaultSettings).forEach(key => (this as any)[key] = settings[key] ?? (defaultSettings as any)[key]);
    this.updateObserver();

    window.addEventListener('beforeunload', () => this.saveSettings());
    setInterval(() => this.saveSettings(), 5000);
  }

  ngOnInit(): void {
    this.primeNgConfig.setTranslation({
      accept: $localize`:for dialog button:Yes`,
      reject: $localize`:for dialog button:No`
    });

    const placeName = this.placeName;

    this.initDone = true;
    this.globe = new Globe('globe-host');
    this.globe.setAppearance(this.appearance);
    this.adjustLatitude();

    this.setNow();
    this.placeName = placeName;

    if (this.delayedCollapse)
      setTimeout(() => this.collapsed = true);

    const docElem = document.documentElement;
    const doResize = (): void => {
      this.graphicsRateChangeCheck();
      setTimeout(() => {
        const height = window.innerHeight;
        const disallowScroll = getCssValue(docElem, 'overflow') === 'hidden';

        docElem.style.setProperty('--mfvh', height + 'px');
        docElem.style.setProperty('--mvh', (height * 0.01) + 'px');
        this.adjustFontScaling();

        if (disallowScroll && (docElem.scrollTop !== 0 || docElem.scrollLeft !== 0)) {
          docElem.scrollTo(0, 0);
          setTimeout(doResize, 50);
        }

        if (this.lastHeight !== height) {
          this.lastHeight = height;
          this.updateGlobe();
        }
      });
    };

    sizeChanges.subscribe(() => doResize());
    doResize();

    setTimeout(() => document.getElementById('graphics-credit').style.opacity = '0', 15000);
    this.graphicsChangeStartTime = -1;
  }

  private saveSettings(): void {
    const settings: any = {};

    Object.keys(defaultSettings).forEach(key => settings[key] = (this as any)[key]);

    if (!isEqual(this.lastSavedSettings, settings)) {
      localStorage.setItem('pac-settings', JSON.stringify(settings));
      this.lastSavedSettings = settings;
    }
  }

  private updateObserver(): void {
    this.observer = new SkyObserver(this._longitude, this._latitude);

    const loc = { latitude: this._latitude, longitude: this._longitude, name: '', zone: this._zone };
  }

  get background(): string { return this._background; }
  set background(value: string) {
    if (this._background !== value) {
      this._background = value;
      document.documentElement.style.setProperty('--background', value);
    }
  }

  get isoFormat(): boolean { return this._isoFormat; }
  set isoFormat(value: boolean) {
    if (this._isoFormat !== value) {
      this._isoFormat = value;
      this.clearTimingReferenceIfNeeded();
      this.updateTime();
    }
  }

  get collapsed(): boolean { return this._collapsed; }
  set collapsed(value: boolean) {
    if (this._collapsed !== value) {
      this._collapsed = value;

      if (this.initDone) {
        if ((document.activeElement as any)?.blur)
          (document.activeElement as any).blur();

        this.adjustFontScaling();
        this.graphicsRateChangeCheck(true);
        this.saveSettings();
      }
      else {
        this.collapsed = false;
        this.delayedCollapse = true;
      }
    }
  }

  get showInfoPanel(): boolean { return this._showInfoPanel; }
  set showInfoPanel(value: boolean) {
    if (this._showInfoPanel !== value) {
      this._showInfoPanel = value;

      if (this.initDone && this.collapsed) {
        this.adjustFontScaling();
        this.graphicsRateChangeCheck(true);
        this.saveSettings();
      }
    }
  }

  get appearance(): number { return this._appearance; }
  set appearance(value: number) {
    if (this.appearance !== value) {
      const wasEmptyCenter = this.emptyCenter;
      this._appearance = value;
      this.emptyCenter = false;
      this.altFour = this.emptyCenter;
      this.globe?.setAppearance(value);

      if (this.emptyCenter !== wasEmptyCenter)
        setTimeout(() => this.adjustLatitude());
    }
  }

  get timing(): number { return this._timing; }
  set timing(value: number) {
    if (this._timing !== value) {
      this._timing = value;

      this.showErrors = false;
      this.showAllErrors = false;
      this.showRecalibration = false;
      this.dstChangeAllowed = true;
      this.timingReference = undefined;

      this.updateTime(true);
    }
  }

  private adjustFontScaling(): void {
    let fontScaler: number;

    if (window.innerHeight > window.innerWidth)
      fontScaler = max(min(window.innerHeight / 1100, 1), 0.75);
    else if (this.collapsed && window.innerWidth > 1100)
      fontScaler = max(min(window.innerWidth / 600, window.innerHeight / 500, 1), 0.75);
    else
      fontScaler = max(min((window.innerWidth - 500) / 600, (window.innerHeight - 400) / 400, 1), 0.75);

    document.documentElement.style.setProperty('--font-scaler', fontScaler.toPrecision(3));
  }

  private clearTimingReferenceIfNeeded(): void {
    return;
  }

  get additionalPlanets(): boolean { return this._additionalPlanets; }
  set additionalPlanets(value: boolean) {
    if (this._additionalPlanets !== value) {
      this._additionalPlanets = value;
      this.checkPlanetOverlaps();
    }
  }

  get realPositionMarkers(): boolean { return this._realPositionMarkers; }
  set realPositionMarkers(value: boolean) {
    if (this._realPositionMarkers !== value) {
      this._realPositionMarkers = value;
      this.checkPlanetOverlaps();
    }
  }

  get playing(): boolean { return this._playing; }
  set playing(value: boolean) {
    if (this._playing !== value) {
      this._playing = value;

      if (value) {
        this.trackTime = false;
        this.playTimeBase = this._time;
        this.playTimeProcessBase = processMillis();
        requestAnimationFrame(this.playStep);
      }
    }
  }

  play(): void {
    if (this.playSpeed !== PlaySpeed.NORMAL) {
      this.playing = false;
      this.playSpeed = PlaySpeed.NORMAL;
    }

    this.playing = true;
  }

  playFast(): void {
    if (this.playSpeed !== PlaySpeed.FAST) {
      this.playing = false;
      this.playSpeed = PlaySpeed.FAST;
    }

    this.playing = true;
  }

  stop(): void {
    if (this.playing) {
      this.playing = false;

      // Round time to the nearest whole minute when animation stops.
      if (this.playSpeed === PlaySpeed.FAST)
        this.time = floor((this.time + 30000) / 60000) * 60000;
    }
  }

  private playStep = (): void => {
    if (!this.playing)
      return;

    const elapsed = processMillis() - this.playTimeProcessBase;

    if (this.playSpeed === PlaySpeed.NORMAL)
      this.time = this.playTimeBase + floor(elapsed / 25) * 60_000;
    else
      this.time = this.playTimeBase + floor(elapsed / 200) *
        (this.animateBySiderealDays ? MILLIS_PER_SIDEREAL_DAY : MILLIS_PER_DAY);

    if (this.lastWallTime && this.lastWallTime.y === this.MAX_YEAR &&
        this.lastWallTime.m === 12 && this.lastWallTime.d === 31)
      this.stop();
    else
      requestAnimationFrame(this.playStep);
  }

  get suppressOsKeyboard(): boolean { return this._suppressOsKeyboard; }
  set suppressOsKeyboard(value: boolean) {
    if (this._suppressOsKeyboard !== value) {
      this._suppressOsKeyboard = value;
    }
  }

  get latitude(): number { return this._latitude; }
  set latitude(newValue: number) {
    if (this._latitude !== newValue) {
      this._latitude = newValue;

      if (this.initDone)
        this.adjustLatitude();
    }
  }

  get longitude(): number { return this._longitude; }
  set longitude(newValue: number) {
    if (this._longitude !== newValue) {
      this._longitude = newValue;
      this.localTimezone = Timezone.getTimezone('LMT', this.longitude);

      if (this.initDone) {
        this.placeName = '';
        this.updateObserver();
        this.clearTimingReferenceIfNeeded();
        this.updateTime(true);
        this.updateGlobe();
      }
    }
  }

  get zone(): string { return this._zone; }
  set zone(newValue: string) {
    if (this._zone !== newValue) {
      this._zone = newValue;

      if (this.initDone) {
        if (newValue === 'LMT') {
          const lon = this._longitude;

          this._longitude = undefined;
          this.longitude = lon;
        }
        else {
          this.placeName = '';
          this.updateObserver();
          this.clearTimingReferenceIfNeeded();
          this.updateTime(true);
        }
      }
    }
  }

  getZone(): string | Timezone {
    return (this.zone === 'LMT' ? this.localTimezone : this.zone);
  }

  get time(): number { return this._time; }
  set time(newValue: number) {
    if (this._time !== newValue) {
      this._time = newValue;

      if (this.initDone)
        this.updateTime();
    }
  }

  get trackTime(): boolean { return this._trackTime; }
  set trackTime(newValue: boolean) {
    if (this._trackTime !== newValue) {
      this._trackTime = newValue;

      if (newValue) {
        const timeStep = (): void => {
          this.setNow();
          this.timeCheck = setTimeout(timeStep, 59999 - Date.now() % 60000);
        };

        timeStep();
      }
      else if (this.timeCheck) {
        clearTimeout(this.timeCheck);
        this.timeCheck = undefined;
      }
    }
  }

  setNow(): void {
    const newTime = new Date(2024, 0, 1).getTime();

    if (this.time !== newTime) {
      this.time = newTime;

      if (this.playing) {
        this.playTimeBase = newTime;
        this.playTimeProcessBase = processMillis();
      }
    }
  }

  private clearZoneFixTimeout(): void {
    if (this.zoneFixTimeout) {
      clearTimeout(this.zoneFixTimeout);
      this.zoneFixTimeout = undefined;
    }
  }

  private adjustLatitude(): void {
    this.graphicsRateChangeCheck();
    this.clearZoneFixTimeout();
    this.updateObserver();
    this.clearTimingReferenceIfNeeded();
    adjustGraphicsForLatitude(this);
    this.placeName = '';
    this.updateTime(true);
    this.updateGlobe();
  }

  private graphicsRateChangeCheck(suppressFilteringImmediately = false): void {
    const now = processMillis();
    const resumeFiltering = (): void => {
      this.svgFilteringOn = true;
      this.graphicsChangeStartTime = -1;
      this.graphicsChangeStopTimer = undefined;
    };

    if (this.svgFilteringOn) {
      if (!suppressFilteringImmediately &&
          (this.graphicsChangeStartTime < 0 ||
           (this.graphicsChangeStartTime > 0 && now > this.graphicsChangeLastTime + START_FILTERING_DELAY) ||
           now > this.graphicsChangeLastTime + STOP_FILTERING_DELAY))
        this.graphicsChangeStartTime = now;
      else if (now > this.graphicsChangeStartTime + STOP_FILTERING_DELAY || suppressFilteringImmediately) {
        this.graphicsChangeStartTime = -1;

        if (!this.playing) {
          this.svgFilteringOn = false;
          this.graphicsChangeStopTimer = setTimeout(resumeFiltering, RESUME_FILTERING_DELAY);
        }
      }
    }
    else if (this.graphicsChangeStopTimer) {
      clearTimeout(this.graphicsChangeStopTimer);

      if (!this.playing)
        this.graphicsChangeStopTimer = setTimeout(resumeFiltering, RESUME_FILTERING_DELAY);
    }

    this.graphicsChangeLastTime = now;
  }

  private updateGlobe(): void {
    this.globe.orient(this._longitude, this.latitude).catch(noop);
  }

  updateTime(forceUpdate = false): void {
    if (!this.observer)
      return;

    this.graphicsRateChangeCheck();

    const jdu = julianDay(this.time);
    const basicPositions = calculateBasicPositions(this.time, this.getZone(), this.observer, this.disableDst);
    const date = basicPositions._date;
    const wt = date.wallTime;

    if (this.playing) {
      const matchingDate = this.STOP_DATES.find(stopDate => 
        stopDate.year === wt.year && 
        stopDate.month === wt.month && 
        stopDate.day === wt.day
      );
      
      if (matchingDate) {
        const dateKey = `${matchingDate.year}-${matchingDate.month}-${matchingDate.day}`;
        if (!this.stoppedDates.has(dateKey)) {
          this.stoppedDates.add(dateKey);
          this.stop();
        }
      }
    }

    // Finding sunset events can be slow at high latitudes, so use cached values when possible.
    if (forceUpdate || !this.sunsetA || !this.sunsetB || jdu <= this.sunsetA.ut || jdu > this.sunsetB.ut) {
      this.sunsetA = this.eventFinder.findEvent(SUN, SET_EVENT, jdu, this.observer, undefined, undefined, true);
      this.sunsetB = this.eventFinder.findEvent(SUN, SET_EVENT, this.sunsetA.ut, this.observer,
        undefined, undefined, false);
    }

    const dayLength = this.sunsetB.ut - this.sunsetA.ut;
    const bohemianHour = (jdu - this.sunsetA.ut) / dayLength * 24;
    const dateLocal = new DateTime(this.time, this.localTimezone);
    const jde = basicPositions._jde;
    const southern = this.self.southern;

    this.lastWallTime = basicPositions._date?.wallTime;
    forEach(basicPositions as any, (key, value) => basicPosKey(key) && ((this as any)['true_' + key] = value));

    this.mercuryAngle = adjustForEclipticWheel(solarSystem.getEclipticPosition(MERCURY, jde).longitude.degrees, southern);
    this.venusAngle = adjustForEclipticWheel(solarSystem.getEclipticPosition(VENUS, jde).longitude.degrees, southern);
    this.marsAngle = adjustForEclipticWheel(solarSystem.getEclipticPosition(MARS, jde).longitude.degrees, southern);
    this.jupiterAngle = adjustForEclipticWheel(solarSystem.getEclipticPosition(JUPITER, jde).longitude.degrees, southern);
    this.saturnAngle = adjustForEclipticWheel(solarSystem.getEclipticPosition(SATURN, jde).longitude.degrees, southern);

    forEach(basicPositions as any, (key, value) => basicPosKey(key) && ((this as any)[key] = value));

    const format = this.isoFormat ? DATETIME_LOCAL : 'ISS{year:numeric,month:2-digit,day:2-digit,hour:2-digit}';

    this.timeText = date.format(format, specificLocale);
    this.timeText = this.isoFormat ? this.timeText.replace('T', '\xA0') : this.timeText;
    this.outerRingAngle = 180 - (bohemianHour - basicPositions._hourOfDay) * 15;
    this.zoneOffset = 'UTC' + Timezone.formatUtcOffset(date.utcOffsetSeconds);
    this.localTime = formatTimeOfDay(date, this.isoFormat);
    this.localMeanTime = formatTimeOfDay(dateLocal, this.isoFormat);
    this.localSolarTime = formatTimeOfDay(this.observer.getApparentSolarTime(jdu).hours, this.isoFormat);
    this.siderealTime = formatTimeOfDay(mod(this.true_siderealAngle + 90, 360) / 15, true);
    this.siderealTimeOrloj = formatTimeOfDay(mod(this.siderealAngle + 90, 360) / 15, true);
    this.bohemianTime = formatTimeOfDay(bohemianHour, true, true); // Round to match rounded sunrise/sunset times

    this.errorMoon = mod2(this.moonAngle.orig - this.true_moonAngle.orig, 360);
    this.errorMoonDays = this.errorMoon / 360 * 27.321;
    this.errorPhase = mod2(this.moonPhase - this.true_moonPhase, 360) * this.rotateSign;
    this.errorPhaseDays = this.errorPhase / 360 * 29.53059;
    this.errorSun = mod2(this.sunAngle.orig - this.true_sunAngle.orig, 360);
    this.errorSunMinutes = this.errorSun / 360 * 1440;

    [this.sunrise, this.sunset] =
      this.extractRiseAndSetTimes(
        this.eventFinder.getRiseAndSetTimes(SUN, wt.year, wt.month, wt.day, this.observer, date.timezone));

    [this.moonrise, this.moonset] =
      this.extractRiseAndSetTimes(
        this.eventFinder.getRiseAndSetTimes(MOON, wt.year, wt.month, wt.day, this.observer, date.timezone));

    this.checkPlanetOverlaps();
  }

  private extractRiseAndSetTimes(events: AstroEvent[]): string[] {
    let rise = '';
    let set = '';

    if (events) {
      for (const evt of events) {
        const time = formatTimeOfDay(evt.eventTime, this.isoFormat);

        if (evt.eventType === RISE_EVENT)
          rise = extendDelimited(rise, time, ', ');
        else if (evt.eventType === SET_EVENT)
          set = extendDelimited(set, time, ', ');
      }
    }

    return [rise || '---', set || '---'];
  }

  private checkPlanetOverlaps(): void {
    const angles =
      [this.mercuryAngle.oe, this.venusAngle.oe, this.marsAngle.oe, this.jupiterAngle.oe,
       this.saturnAngle.oe, -999, -999];

    if (this.realPositionMarkers) {
      angles[5] = this.true_sunAngle.oe;
      angles[6] = this.true_moonAngle.oe;
    }

    this.overlapShift.fill(0);

    for (let i = 0; i <= 4; ++i) {
      let maxShift = 0;
      const angle = angles[i];

      for (let j = i + 1; j <= 6; ++j) {
        if (abs(mod2(angle - angles[j], 360)) < 2.5)
          maxShift = max((this.overlapShift[j] || 0) + 3, maxShift);
      }

      this.overlapShift[i] = maxShift;
    }
  }

  eclipticTransform(): string {
    return this.rotate(this.siderealAngle) + (this.self.southern ? ' scale(1, -1)' : '');
  }

  rotate(angle: number): string {
    return `rotate(${angle * this.rotateSign})`;
  }

  reorient(angle: AngleTriplet): string {
    return isSafari() ? null : this.self.southern ?
      `scale(-1, 1) rotate(${90 + angle.orig - angle.oe})` : `rotate(${90 - angle.orig - angle.oe})`;
  }

  sunlitMoonPath(): string {
    return sunlitMoonPath(this);
  }

  checkIfTimeIsEditable(): void {
    if (!this.trackTime)
      return;

    this.confirmService.confirm({
      message: $localize`Turn off "Track current time" so you can edit the time?`,
      accept: () => this.trackTime = false
    });
  }

  private setEventType(eventType: EventType): void {
    if (this.eventType !== eventType) {
      this.eventType = eventType;
    }
  }

  editName(): void {
    this.canEditName = false;
    this.canSaveName = true;
    this.inputName = this.placeName || '';
    this.inputLength = this.inputName.trim().length;

    setTimeout(() => document.getElementById('name-input')?.focus());
  }

  inputChanged(evt: any): void {
    this.inputName = (evt.target as HTMLInputElement).value || '';
    this.inputLength = this.inputName.trim().length;
  }

  cancelEdit(): void {
    this.canEditName = true;
    this.canSaveName = false;
  }

  eventClick(evt?: TouchEvent | MouseEvent, goBack = false): void {
    if (!evt)
      this.stopEventClickTimer();
    else if (evt?.type === 'touchstart' || evt?.type === 'mousedown') {
      if (evt.type === 'touchstart' && evt.cancelable)
        evt.preventDefault();

      this.eventGoBack = goBack;

      if (!this.eventClickTimer) {
        this.eventClickTimer = timer(CLICK_REPEAT_DELAY, CLICK_REPEAT_RATE).subscribe(() => {
          this.skipToEvent(this.eventGoBack);
        });
      }
    }
    else if (evt?.type === 'touchend' || evt?.type === 'mouseup') {
      if (evt.type === 'touchend' && evt.cancelable)
        evt.preventDefault();

      if (this.eventClickTimer) {
        this.stopEventClickTimer();
        this.skipToEvent(this.eventGoBack);
      }
    }
  }

  private stopEventClickTimer(): void {
    if (this.eventClickTimer) {
      this.eventClickTimer.unsubscribe();
      this.eventClickTimer = undefined;
    }
  }

  private skipToEvent(previous: boolean): void {
    if (this.trackTime) {
      this.stopEventClickTimer();
      this.confirmService.confirm({
        message: $localize`Turn off "Track current time" and change the clock time?`,
        accept: () => {
          this.trackTime = false;
          this.skipToEvent(previous);
        }
      });

      return;
    }

    const jdu = julianDay(this.time);
    let eventsToCheck: number[] = [];
    const eventsFound: AstroEvent[] = [];

    switch (this.eventType) {
      case EventType.EQUISOLSTICE:
        eventsToCheck = [SPRING_EQUINOX, SUMMER_SOLSTICE, FALL_EQUINOX, WINTER_SOLSTICE];
        break;
      case EventType.MOON_PHASE:
        eventsToCheck = [NEW_MOON, FIRST_QUARTER, FULL_MOON, LAST_QUARTER];
        break;
      case EventType.RISE_SET:
        eventsToCheck = [RISE_EVENT, TRANSIT_EVENT, SET_EVENT];
        break;
    }

    for (const eventType of eventsToCheck) {
      const evt = this.eventFinder.findEvent(SUN, eventType, jdu, this.observer, undefined, undefined, previous);

      if (evt)
        eventsFound.push(evt);
    }

    eventsFound.sort((a, b) => previous ? b.ut - a.ut : a.ut - b.ut);

    if (eventsFound.length > 0) {
      const evt = eventsFound[0];
      const eventText = AppComponent.translateEvent(evt.eventText);
      const year = new DateTime(evt.eventTime.utcMillis, this.zone).wallTime.year;

      this.messageService.clear();

      if (year < this.MIN_YEAR || year > this.MAX_YEAR)
        this.messageService.add({ severity: 'error', summary: $localize`Event`,
                                  detail: $localize`Event outside of ${this.MIN_YEAR}-${this.MAX_YEAR} year range.` });
      else {
        this.time = evt.eventTime.utcMillis;
        this.messageService.add({ severity: 'info', summary: $localize`Event`, detail: eventText });
      }
    }
  }

  private static translateEvent(text: string): string {
    if (text.match(/\brise\b/i))
      return $localize`Sunrise`;
    else if (text.match(/\bset\b/i))
      return $localize`Sunset`;
    else if (text.match(/\btransit\b/i))
      return $localize`Transit`;
    else if (text.match(/\bvernal equinox\b/i))
      return $localize`Vernal equinox`;
    else if (text.match(/\bsummer solstice\b/i))
      return $localize`Summer solstice`;
    else if (text.match(/\bautumnal equinox\b/i))
      return $localize`Autumnal equinox`;
    else if (text.match(/\bwinter solstice\b/i))
      return $localize`Winter Solstice`;
    else if (text.match(/\bnew moon\b/i))
      return $localize`New moon`;
    else if (text.match(/\b(1st|first)\b/i))
      return $localize`First quarter`;
    else if (text.match(/\bfull moon\b/i))
      return $localize`Full moon`;
    else if (text.match(/\b(3rd|third)\b/i))
      return $localize`Third quarter`;
    else
      return text;
  }
}
