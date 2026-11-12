/* Copy of ../../app/schema.js — do not edit here. Edit the original, then run: node tools/sync-server.js */
/*! Stalia — reading documents: the shape of the answer a reader gives (shared by the site and the reading server). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaliaSchema = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- the reader's answer (JSON Schema)
  // Every field is required and has a plain type: "" means "not stated", "unknown" means "the documents do not say".
  // That keeps the schema free of unions, which structured-output grammars handle most reliably.
  const YNU = ['yes', 'no', 'unknown'];
  const DAYS = ['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const REGIMES = ['SHINC', 'SHEX', 'SSHEX', 'SATNOON', 'FRI17', 'FHEX', 'FSHEX', 'CUSTOM', 'unknown'];
  const EVENT_TYPES = ['weather', 'shifting', 'awaiting', 'breakdown', 'owner', 'survey', 'strike', 'worked', 'note', 'custom'];
  const STATUSES = ['not_found', 'redacted', 'ambiguous', 'assumed'];

  /** What a note can be about. app/extract.js gives each of these a label and a form field. */
  const FIELD_CODES = [
    'vessel', 'voyage', 'cp_form', 'cp_date', 'owners', 'charterers', 'cargo',
    'currency', 'demurrage_rate', 'despatch', 'despatch_basis', 'commission', 'laytime_between_ports', 'exceptions_on_demurrage',
    'port', 'laytime_allowed', 'working_time', 'holidays', 'work_in_excepted_time', 'notice_rule', 'office_hours',
    'nor_tendered', 'operations_commenced', 'operations_completed', 'events', 'other',
  ];

  const str = (description, values) => (values ? { type: 'string', enum: values, description } : { type: 'string', description });
  const obj = (properties, description) => {
    const o = { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
    if (description) o.description = description;
    return o;
  };
  const list = (items, description) => ({ type: 'array', items, description });
  const DT = 'Local port time as written in the document, formatted YYYY-MM-DDTHH:MM (24-hour clock). "" if not stated.';
  const HM = 'HH:MM, 24-hour clock. "" if not stated.';
  const NUM = 'Digits only, "." as the decimal separator, no thousands separators, no units. "" if not stated.';

  const SCHEMA = obj({
    documents: obj({
      charter_party: str('Whether pages of a charter party, fixture recap or laytime clauses were supplied and could be read.', ['read', 'absent', 'unreadable']),
      statement_of_facts: str('Whether pages of a statement of facts, time sheet or port log were supplied and could be read.', ['read', 'absent', 'unreadable']),
    }),
    fixture: obj({
      vessel: str('Vessel name as written, e.g. "MV EXAMPLE TRADER". "" if not stated or blacked out.'),
      voyage: str('Voyage or reference number. "" if not stated.'),
      charter_party_form: str('Charter party form, e.g. "Gencon 1994", "Asbatankvoy", "Synacomex 2000". "" if not stated.'),
      charter_party_date: str('Date of the charter party, YYYY-MM-DD. "" if not stated.'),
      owners: str('Owners / disponent owners as written. "" if not stated or blacked out.'),
      charterers: str('Charterers as written. "" if not stated or blacked out.'),
      cargo: str('Short cargo description, e.g. "27,500 MT wheat in bulk". "" if not stated.'),
    }),
    money: obj({
      currency: str('ISO 4217 code of the demurrage rate, e.g. "USD". "" if not stated.'),
      demurrage_per_day: str('Demurrage rate per day. ' + NUM),
      despatch: str('How despatch is paid: half the demurrage rate, its own stated rate, none ("free despatch", or a charter party with no despatch clause), or unknown.', ['half_demurrage', 'own_rate', 'none', 'unknown']),
      despatch_per_day: str('Despatch rate per day when it has its own rate. ' + NUM),
      despatch_basis: str('Despatch on working time saved or on all time saved.', ['working_time_saved', 'all_time_saved', 'unknown']),
      commission_percent: str('Total commission in percent that the charter party makes payable on demurrage (address commission plus brokerage where both apply to demurrage). ' + NUM),
    }),
    laytime: obj({
      between_ports: str('reversible = one pooled allowance for loading and discharging; separate = each port has its own; average = time saved at one port offsets time lost at the other.', ['reversible', 'separate', 'average', 'unknown']),
      clauses: str('The clauses of the charter party that decide the count, in the charter party\'s own words, shortened, one per line: when laytime starts and stops at each port, what does not count or counts in part, and how each of these is treated on demurrage. At most 1200 characters. "" when no charter party was supplied.'),
      exceptions_apply_on_demurrage: str('"yes" only if the charter party says that weekends, holidays or weather also interrupt demurrage. "no" for "once on demurrage, always on demurrage" and when the charter party is read and says nothing.', YNU),
    }),
    ports: list(obj({
      name: str('Port name, with the berth if stated. "" if not stated or blacked out.'),
      operation: str('Loading or discharging.', ['load', 'discharge']),
      allowed: obj({
        basis: str('cargo_and_rate when laytime is cargo quantity divided by a daily or hourly rate; fixed_time when it is a number of days or hours.', ['cargo_and_rate', 'fixed_time', 'unknown']),
        cargo_quantity: str('Cargo quantity in metric tons used for laytime at this port: the bill of lading or outturn figure when the documents give it, otherwise the charter party quantity. ' + NUM),
        rate: str('Loading or discharging rate in metric tons. ' + NUM),
        rate_per: str('Whether the rate is per day or per hour.', ['day', 'hour']),
        days: str('Fixed laytime: days. ' + NUM),
        hours: str('Fixed laytime: hours (72 running hours = "72"). ' + NUM),
        minutes: str('Fixed laytime: minutes. ' + NUM),
      }),
      working_time: obj({
        regime: str('SHINC, SHEX (Sundays and holidays excepted), SSHEX (Saturdays, Sundays and holidays excepted), SATNOON (Saturday 12:00 to Monday 08:00 excepted), FRI17 (Friday 17:00 to Monday 08:00 excepted), FHEX (Fridays and holidays excepted), FSHEX (Fridays, Saturdays and holidays excepted), CUSTOM for any other weekly excepted period, unknown if the documents do not say.', REGIMES),
        custom_from_day: str('CUSTOM only: the day the weekly excepted period starts.', DAYS),
        custom_from_time: str('CUSTOM only: the time it starts. ' + HM),
        custom_to_day: str('CUSTOM only: the day it ends.', DAYS),
        custom_to_time: str('CUSTOM only: the time it ends. ' + HM),
        holidays_excepted: str('Whether holidays are excepted from laytime.', YNU),
        holiday_from_previous_day_at: str('If the excepted period of a holiday starts on the day before (e.g. 17:00), that time. ' + HM),
        holiday_until_next_day_at: str('If it ends on the day after (e.g. 08:00), that time. ' + HM),
        work_in_excepted_time: str('counts = "unless used" (time actually used counts); does_not_count = "even if used".', ['counts', 'does_not_count', 'unknown']),
        holidays: list(obj({ date: str('YYYY-MM-DD'), name: str('Name of the holiday, "" if not given.') }),
          'Holidays at this port that the documents themselves name with a date and that fall within the port call. Never add holidays from general knowledge.'),
      }),
      notice: obj({
        tendered: str('When notice of readiness was tendered. ' + DT),
        rule: str('hours_after_notice = laytime starts a fixed number of hours after NOR; noon_rule = NOR before noon starts laytime the same day, later NOR the next working day (Gencon); next_working_day = laytime starts at a set time on the next working day after NOR, whatever the hour of the notice; stated_time = no rule can be read, but a time sheet states when laytime commenced; unknown.', ['hours_after_notice', 'noon_rule', 'next_working_day', 'stated_time', 'unknown']),
        hours_after_notice: str('Notice (turn) time in hours; "0" when laytime starts as soon as notice is tendered. ' + NUM),
        noon_rule_morning_start: str('Noon rule: the time laytime starts when NOR is given up to noon (Gencon: 13:00). ' + HM),
        noon_rule_afternoon_start: str('Noon rule: the time laytime starts on the next working day when NOR is given after noon (Gencon: 06:00). ' + HM),
        next_working_day_start: str('next_working_day only: the time laytime starts on that day (e.g. 08:00). ' + HM),
        laytime_commenced_at: str('stated_time only: when laytime commenced according to the time sheet. ' + DT),
        unless_sooner_commenced: str('Whether laytime starts earlier if cargo work starts before the notice time has run.', YNU),
        office_hours_only: str('Whether NOR counts only if tendered within office hours.', YNU),
        office_from: str('Office hours start. ' + HM),
        office_to: str('Office hours end. ' + HM),
        office_saturday_to: str('Office hours end on Saturday. ' + HM),
      }),
      operations_commenced: str('When loading or discharging actually commenced. ' + DT),
      operations_completed: str('The moment laytime stops at this port: the event the charter party names, otherwise completion of loading or discharging (tankers: hoses disconnected). ' + DT),
      events: list(obj({
        type: str('weather = rain or bad weather; shifting = shifting between anchorage and berth or between berths; awaiting = awaiting tide, daylight, pilot or tugs; breakdown = breakdown of the vessel or her gear; owner = ballasting, bunkering, stores and other Owners’ purposes; survey = draft survey, inspection, sampling; strike = strike or force majeure; worked = cargo work actually done during a weekend or holiday that is excepted; note = a fact kept for the record that has no effect on the count; custom = anything else.', EVENT_TYPES),
        from: str('Start. ' + DT),
        to: str('End. ' + DT + ' "" for a note.'),
        description: str('Wording for the time sheet, taken from the document and kept short.'),
        counts_percent: str('Share of this period that counts as laytime: "0" does not count, "50" half, "100" counts in full. "" for the usual effect of the type.'),
        on_demurrage: str('stops_too = this period is also deducted once the vessel is on demurrage (e.g. vessel breakdown); keeps_running = demurrage runs through it; default = the usual effect of the type.', ['stops_too', 'keeps_running', 'default']),
      }), 'Periods of the statement of facts that affect the laytime count, in time order.'),
    }), 'One entry per port call for which the documents give times, in time order. If only a charter party was supplied, one entry per port it names.'),
    notes: list(obj({
      field: str('What the note is about.', FIELD_CODES),
      port: { type: 'integer', description: 'Number of the port in "ports" that the note is about, starting at 1. 0 if it is about the whole fixture.' },
      status: str('not_found = the documents do not give it; redacted = it is under a blacked-out area; ambiguous = it can be read in more than one way; assumed = you chose a value the documents do not state outright.', STATUSES),
      comment: str('One short sentence for the user, in the language they asked for: what to check and why.'),
    }), 'Everything the user should check or fill in by hand.'),
  });

  /** An empty, schema-shaped answer: the starting point for tests and for a document that held nothing. */
  function blankExtraction() {
    return {
      documents: { charter_party: 'absent', statement_of_facts: 'absent' },
      fixture: { vessel: '', voyage: '', charter_party_form: '', charter_party_date: '', owners: '', charterers: '', cargo: '' },
      money: { currency: '', demurrage_per_day: '', despatch: 'unknown', despatch_per_day: '', despatch_basis: 'unknown', commission_percent: '' },
      laytime: { between_ports: 'unknown', clauses: '', exceptions_apply_on_demurrage: 'unknown' },
      ports: [], notes: [],
    };
  }
  function blankExtractionPort(operation) {
    return {
      name: '', operation: operation || 'load',
      allowed: { basis: 'unknown', cargo_quantity: '', rate: '', rate_per: 'day', days: '', hours: '', minutes: '' },
      working_time: {
        regime: 'unknown', custom_from_day: '', custom_from_time: '', custom_to_day: '', custom_to_time: '', holidays_excepted: 'unknown',
        holiday_from_previous_day_at: '', holiday_until_next_day_at: '', work_in_excepted_time: 'unknown', holidays: [],
      },
      notice: {
        tendered: '', rule: 'unknown', hours_after_notice: '', noon_rule_morning_start: '', noon_rule_afternoon_start: '', next_working_day_start: '', laytime_commenced_at: '',
        unless_sooner_commenced: 'unknown', office_hours_only: 'unknown', office_from: '', office_to: '', office_saturday_to: '',
      },
      operations_commenced: '', operations_completed: '', events: [],
    };
  }

  // ---------------------------------------------------------------- checking an answer against the schema
  /** @returns {string} '' when `value` has exactly the shape of `schema`, otherwise where it first differs. */
  function shapeError(value, schema, where) {
    where = where || 'answer';
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return where + ' must be an object';
      for (const k of schema.required) {
        if (!(k in value)) return where + '.' + k + ' is missing';
        const e = shapeError(value[k], schema.properties[k], where + '.' + k);
        if (e) return e;
      }
      for (const k of Object.keys(value)) if (!(k in schema.properties)) return where + '.' + k + ' is not expected';
      return '';
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) return where + ' must be a list';
      for (let i = 0; i < value.length; i++) { const e = shapeError(value[i], schema.items, where + '[' + i + ']'); if (e) return e; }
      return '';
    }
    if (schema.type === 'integer') return Number.isInteger(value) ? '' : where + ' must be a whole number';
    if (typeof value !== 'string') return where + ' must be text';
    if (schema.enum && schema.enum.indexOf(value) < 0) return where + ' has an unexpected value';
    return '';
  }

  /**
   * Bring an answer that is almost right into the exact shape of `schema`: missing fields are filled with the
   * "not stated" value, unknown fields are dropped, numbers become text. For readers whose output is not held
   * to the schema by the API itself (the preview build asks Claude without that guarantee).
   */
  function conform(value, schema) {
    if (schema.type === 'object') {
      const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const out = {};
      for (const k of schema.required) out[k] = conform(src[k], schema.properties[k]);
      return out;
    }
    if (schema.type === 'array') return (Array.isArray(value) ? value : []).map((v) => conform(v, schema.items));
    if (schema.type === 'integer') return Number.isInteger(value) ? value : (Number.isFinite(Number(value)) && value !== '' && value != null ? Math.round(Number(value)) : 0);
    const s = value == null || typeof value === 'object' ? '' : String(value);
    if (!schema.enum) return s;
    if (schema.enum.indexOf(s) >= 0) return s;
    for (const neutral of ['unknown', '', 'default', 'absent']) if (schema.enum.indexOf(neutral) >= 0) return neutral;
    return schema.enum[0];
  }

  return { SCHEMA, FIELD_CODES, EVENT_TYPES, STATUSES, REGIMES, blankExtraction, blankExtractionPort, shapeError, conform };
});
