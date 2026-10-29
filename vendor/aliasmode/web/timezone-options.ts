/**
 * Timezone choices for the fingerprint panel. The runtime list is preferred
 * (it follows the installed ICU data); the pinned list below keeps older
 * webviews usable and makes the dialog deterministic in tests.
 */

export interface TimezoneGroup {
  label: string;
  zones: string[];
}

export type TimezoneSelection = { kind: "auto"; value: "" } | { kind: "known" | "custom"; value: string };

const CONTINENT_ORDER = ["美洲", "欧洲", "亚洲", "非洲", "大洋洲", "太平洋", "大西洋", "印度洋", "南极洲", "北极", "其他"];

const REGION_LABELS: Readonly<Record<string, string>> = {
  America: "美洲",
  US: "美洲",
  Canada: "美洲",
  Mexico: "美洲",
  Brazil: "美洲",
  Chile: "美洲",
  Europe: "欧洲",
  Asia: "亚洲",
  Africa: "非洲",
  Australia: "大洋洲",
  Pacific: "太平洋",
  Atlantic: "大西洋",
  Indian: "印度洋",
  Antarctica: "南极洲",
  Arctic: "北极",
};

/** Pinned IANA zones used when Intl.supportedValuesOf is unavailable. */
export const FALLBACK_TIMEZONES: readonly string[] = [
  "Africa/Abidjan", "Africa/Accra", "Africa/Addis_Ababa", "Africa/Algiers", "Africa/Bamako", "Africa/Bangui",
  "Africa/Banjul", "Africa/Bissau", "Africa/Blantyre", "Africa/Brazzaville", "Africa/Bujumbura", "Africa/Cairo",
  "Africa/Casablanca", "Africa/Ceuta", "Africa/Conakry", "Africa/Dakar", "Africa/Dar_es_Salaam", "Africa/Djibouti",
  "Africa/Douala", "Africa/El_Aaiun", "Africa/Freetown", "Africa/Gaborone", "Africa/Harare", "Africa/Johannesburg",
  "Africa/Juba", "Africa/Kampala", "Africa/Khartoum", "Africa/Kigali", "Africa/Kinshasa", "Africa/Lagos",
  "Africa/Libreville", "Africa/Lome", "Africa/Luanda", "Africa/Lubumbashi", "Africa/Lusaka", "Africa/Malabo",
  "Africa/Maputo", "Africa/Maseru", "Africa/Mbabane", "Africa/Mogadishu", "Africa/Monrovia", "Africa/Nairobi",
  "Africa/Ndjamena", "Africa/Niamey", "Africa/Nouakchott", "Africa/Ouagadougou", "Africa/Porto-Novo",
  "Africa/Sao_Tome", "Africa/Tripoli", "Africa/Tunis", "Africa/Windhoek",
  "America/Adak", "America/Anchorage", "America/Anguilla", "America/Antigua", "America/Argentina/Buenos_Aires",
  "America/Argentina/Catamarca", "America/Argentina/Cordoba", "America/Argentina/Jujuy", "America/Argentina/Mendoza",
  "America/Argentina/Salta", "America/Argentina/San_Juan", "America/Argentina/San_Luis", "America/Argentina/Ushuaia",
  "America/Aruba", "America/Asuncion", "America/Atikokan", "America/Bahia", "America/Bahia_Banderas",
  "America/Barbados", "America/Belize", "America/Boa_Vista", "America/Bogota", "America/Boise",
  "America/Cambridge_Bay", "America/Campo_Grande", "America/Cancun", "America/Caracas", "America/Cayenne",
  "America/Cayman", "America/Chicago", "America/Chihuahua", "America/Costa_Rica", "America/Creston",
  "America/Cuiaba", "America/Curacao", "America/Danmarkshavn", "America/Dawson", "America/Dawson_Creek",
  "America/Denver", "America/Detroit", "America/Dominica", "America/Edmonton", "America/Eirunepe",
  "America/El_Salvador", "America/Fortaleza", "America/Glace_Bay", "America/Goose_Bay", "America/Grand_Turk",
  "America/Grenada", "America/Guadeloupe", "America/Guatemala", "America/Guayaquil", "America/Guyana",
  "America/Halifax", "America/Havana", "America/Hermosillo", "America/Indiana/Indianapolis", "America/Indiana/Knox",
  "America/Indiana/Marengo", "America/Indiana/Petersburg", "America/Indiana/Tell_City", "America/Indiana/Vevay",
  "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Inuvik", "America/Iqaluit", "America/Jamaica",
  "America/Juneau", "America/Kentucky/Louisville", "America/Kentucky/Monticello", "America/La_Paz", "America/Lima",
  "America/Los_Angeles", "America/Lower_Princes", "America/Maceio", "America/Managua", "America/Manaus",
  "America/Martinique", "America/Matamoros", "America/Mazatlan", "America/Menominee", "America/Merida",
  "America/Metlakatla", "America/Mexico_City", "America/Miquelon", "America/Moncton", "America/Monterrey",
  "America/Montevideo", "America/Montserrat", "America/Nassau", "America/New_York", "America/Nome",
  "America/Noronha", "America/North_Dakota/Beulah", "America/North_Dakota/Center", "America/North_Dakota/New_Salem",
  "America/Nuuk", "America/Ojinaga", "America/Panama", "America/Paramaribo", "America/Phoenix",
  "America/Port-au-Prince", "America/Port_of_Spain", "America/Porto_Velho", "America/Puerto_Rico",
  "America/Punta_Arenas", "America/Rainy_River", "America/Rankin_Inlet", "America/Recife", "America/Regina",
  "America/Resolute", "America/Rio_Branco", "America/Santarem", "America/Santiago", "America/Santo_Domingo",
  "America/Sao_Paulo", "America/Scoresbysund", "America/Sitka", "America/St_Barthelemy", "America/St_Johns",
  "America/St_Kitts", "America/St_Lucia", "America/St_Thomas", "America/St_Vincent", "America/Swift_Current",
  "America/Tegucigalpa", "America/Thule", "America/Thunder_Bay", "America/Tijuana", "America/Toronto",
  "America/Tortola", "America/Vancouver", "America/Whitehorse", "America/Winnipeg", "America/Yakutat",
  "America/Yellowknife",
  "Antarctica/Casey", "Antarctica/Davis", "Antarctica/DumontDUrville", "Antarctica/Macquarie", "Antarctica/Mawson",
  "Antarctica/McMurdo", "Antarctica/Palmer", "Antarctica/Rothera", "Antarctica/Syowa", "Antarctica/Troll",
  "Antarctica/Vostok",
  "Arctic/Longyearbyen",
  "Asia/Aden", "Asia/Almaty", "Asia/Amman", "Asia/Anadyr", "Asia/Aqtau", "Asia/Aqtobe", "Asia/Ashgabat",
  "Asia/Atyrau", "Asia/Baghdad", "Asia/Bahrain", "Asia/Baku", "Asia/Bangkok", "Asia/Barnaul", "Asia/Beirut",
  "Asia/Bishkek", "Asia/Brunei", "Asia/Chita", "Asia/Colombo", "Asia/Damascus", "Asia/Dhaka", "Asia/Dili",
  "Asia/Dubai", "Asia/Dushanbe", "Asia/Famagusta", "Asia/Gaza", "Asia/Hebron", "Asia/Ho_Chi_Minh",
  "Asia/Hong_Kong", "Asia/Hovd", "Asia/Irkutsk", "Asia/Jakarta", "Asia/Jayapura", "Asia/Jerusalem", "Asia/Kabul",
  "Asia/Kamchatka", "Asia/Karachi", "Asia/Kathmandu", "Asia/Khandyga", "Asia/Kolkata", "Asia/Krasnoyarsk",
  "Asia/Kuala_Lumpur", "Asia/Kuching", "Asia/Kuwait", "Asia/Macau", "Asia/Magadan", "Asia/Makassar",
  "Asia/Manila", "Asia/Muscat", "Asia/Nicosia", "Asia/Novokuznetsk", "Asia/Novosibirsk", "Asia/Omsk",
  "Asia/Oral", "Asia/Phnom_Penh", "Asia/Pontianak", "Asia/Pyongyang", "Asia/Qatar", "Asia/Qostanay",
  "Asia/Qyzylorda", "Asia/Riyadh", "Asia/Sakhalin", "Asia/Samarkand", "Asia/Seoul", "Asia/Shanghai",
  "Asia/Singapore", "Asia/Srednekolymsk", "Asia/Taipei", "Asia/Tashkent", "Asia/Tbilisi", "Asia/Tehran",
  "Asia/Thimphu", "Asia/Tokyo", "Asia/Tomsk", "Asia/Ulaanbaatar", "Asia/Urumqi", "Asia/Ust-Nera",
  "Asia/Vientiane", "Asia/Vladivostok", "Asia/Yakutsk", "Asia/Yangon", "Asia/Yekaterinburg", "Asia/Yerevan",
  "Atlantic/Azores", "Atlantic/Bermuda", "Atlantic/Canary", "Atlantic/Cape_Verde", "Atlantic/Faroe",
  "Atlantic/Madeira", "Atlantic/Reykjavik", "Atlantic/South_Georgia", "Atlantic/St_Helena", "Atlantic/Stanley",
  "Australia/Adelaide", "Australia/Brisbane", "Australia/Broken_Hill", "Australia/Darwin", "Australia/Eucla",
  "Australia/Hobart", "Australia/Lindeman", "Australia/Lord_Howe", "Australia/Melbourne", "Australia/Perth",
  "Australia/Sydney",
  "Europe/Amsterdam", "Europe/Andorra", "Europe/Astrakhan", "Europe/Athens", "Europe/Belgrade", "Europe/Berlin",
  "Europe/Bratislava", "Europe/Brussels", "Europe/Bucharest", "Europe/Budapest", "Europe/Busingen",
  "Europe/Chisinau", "Europe/Copenhagen", "Europe/Dublin", "Europe/Gibraltar", "Europe/Guernsey",
  "Europe/Helsinki", "Europe/Isle_of_Man", "Europe/Istanbul", "Europe/Jersey", "Europe/Kaliningrad",
  "Europe/Kiev", "Europe/Kirov", "Europe/Lisbon", "Europe/Ljubljana", "Europe/London", "Europe/Luxembourg",
  "Europe/Madrid", "Europe/Malta", "Europe/Mariehamn", "Europe/Minsk", "Europe/Monaco", "Europe/Moscow",
  "Europe/Oslo", "Europe/Paris", "Europe/Podgorica", "Europe/Prague", "Europe/Riga", "Europe/Rome",
  "Europe/Samara", "Europe/San_Marino", "Europe/Sarajevo", "Europe/Saratov", "Europe/Simferopol",
  "Europe/Skopje", "Europe/Sofia", "Europe/Stockholm", "Europe/Tallinn", "Europe/Tirane", "Europe/Ulyanovsk",
  "Europe/Uzhgorod", "Europe/Vaduz", "Europe/Vatican", "Europe/Vienna", "Europe/Vilnius", "Europe/Volgograd",
  "Europe/Warsaw", "Europe/Zagreb", "Europe/Zaporozhye", "Europe/Zurich",
  "Indian/Antananarivo", "Indian/Chagos", "Indian/Christmas", "Indian/Cocos", "Indian/Comoro",
  "Indian/Kerguelen", "Indian/Mahe", "Indian/Maldives", "Indian/Mauritius", "Indian/Mayotte", "Indian/Reunion",
  "Pacific/Apia", "Pacific/Auckland", "Pacific/Bougainville", "Pacific/Chatham", "Pacific/Chuuk",
  "Pacific/Easter", "Pacific/Efate", "Pacific/Enderbury", "Pacific/Fakaofo", "Pacific/Fiji", "Pacific/Funafuti",
  "Pacific/Galapagos", "Pacific/Gambier", "Pacific/Guadalcanal", "Pacific/Guam", "Pacific/Honolulu",
  "Pacific/Kiritimati", "Pacific/Kosrae", "Pacific/Kwajalein", "Pacific/Majuro", "Pacific/Marquesas",
  "Pacific/Midway", "Pacific/Nauru", "Pacific/Niue", "Pacific/Norfolk", "Pacific/Noumea", "Pacific/Pago_Pago",
  "Pacific/Palau", "Pacific/Pitcairn", "Pacific/Pohnpei", "Pacific/Port_Moresby", "Pacific/Rarotonga",
  "Pacific/Tahiti", "Pacific/Tarawa", "Pacific/Tongatapu", "Pacific/Wake", "Pacific/Wallis",
  "UTC",
];

type SupportedValuesOf = (key: "timeZone") => string[];

function runtimeSupportedValuesOf(): SupportedValuesOf | undefined {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf !== "function") return undefined;
  return (key) => intl.supportedValuesOf!(key);
}

/**
 * The runtime IANA list, or the pinned fallback when the engine has no
 * Intl.supportedValuesOf (or returns nothing usable).
 */
export function timezoneList(source: SupportedValuesOf | null = runtimeSupportedValuesOf() ?? null): string[] {
  if (source) {
    try {
      const values = source("timeZone");
      if (Array.isArray(values)) {
        const usable = values.filter((value) => typeof value === "string" && value.trim() !== "");
        if (usable.length > 0) return usable;
      }
    } catch {
      // Older engines can expose the function and still throw on unknown keys.
    }
  }
  return [...FALLBACK_TIMEZONES];
}

export function systemTimezones(): string[] {
  return timezoneList();
}

/** Groups zones under Chinese continent labels, keeping the source order inside each group. */
export function groupTimezones(zones: readonly string[]): TimezoneGroup[] {
  const buckets = new Map<string, string[]>();
  for (const zone of zones) {
    const region = zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "";
    const label = REGION_LABELS[region] ?? "其他";
    const bucket = buckets.get(label);
    if (bucket) bucket.push(zone);
    else buckets.set(label, [zone]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      const left = CONTINENT_ORDER.indexOf(a);
      const right = CONTINENT_ORDER.indexOf(b);
      return (left < 0 ? CONTINENT_ORDER.length : left) - (right < 0 ? CONTINENT_ORDER.length : right);
    })
    .map(([label, grouped]) => ({ label, zones: grouped }));
}

/** Automatic (empty), a known dropdown value, or a typed custom zone. */
export function resolveTimezoneSelection(
  value: string,
  known: ReadonlySet<string> | readonly string[] = systemTimezones(),
): TimezoneSelection {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "auto", value: "" };
  const lookup = known instanceof Set ? known : new Set(known);
  return lookup.has(trimmed) ? { kind: "known", value: trimmed } : { kind: "custom", value: trimmed };
}

/** The stored value keeps the typed tag verbatim so an unknown zone is not silently lost. */
export function timezoneForSave(value: string): string {
  return value.trim();
}

/** Mirrors the server-side check in parseStrictTimezone. */
export function isValidIanaTimezone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}
