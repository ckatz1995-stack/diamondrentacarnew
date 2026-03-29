export const VAT_RATE = 0.24;

export const DEFAULT_BUSINESS_SETTINGS = {
  title: 'Business settings',
  currency: 'EUR',
  vatRate: 24,
  vatRateDecimal: VAT_RATE,
  nightStartHour: 22,
  nightEndHour: 8,
  defaultDeposit: 300,
  companyName: 'DIAMOND Rent A Car',
  companyTagline: 'Ενοικίαση οχημάτων στη Θεσσαλονίκη με καθαρή διαδικασία και γρήγορη επιβεβαίωση.',
  companyCity: 'Thessaloniki',
  companyAddress: 'Θεσσαλονίκη, Ελλάδα',
  footerNote: 'Επαγγελματική εμπειρία ενοικίασης οχήματος με καθαρή ροή κράτησης, ξεκάθαρη τιμολόγηση και προσωπική επιβεβαίωση.',
  companyPhone: '+30 2310 000 000',
  companyEmail: 'info@diamondrentacar.gr',
  operatingHoursLabel: '09:00 - 21:00',
  afterHoursNotice: 'Για εξυπηρέτηση εκτός ωραρίου ισχύουν επιπλέον χρεώσεις.',
  allowOverbooking: false,
  enableTriggeredEmails: false,
  bookingConfirmedTriggerId: '',
  bookingCanceledTriggerId: '',
  vehiclesPageDisplayMode: 'categories',
  vehiclesPageModelsSource: 'fleet',
  insuranceTermsTitle: 'Όροι και λεπτομέρειες ασφαλειών',
  insuranceTermsIntro: 'Οι ασφαλιστικές επιλογές και οι σχετικοί όροι παρουσιάζονται με απλό τρόπο πριν από την ολοκλήρωση της κράτησης.',
  insuranceTermsBody: 'Η βασική κάλυψη αφορά την τυπική συμμετοχή του ενοικιαστή σύμφωνα με τους όρους της εταιρίας. Οι επιπλέον καλύψεις μειώνουν ή περιορίζουν την ευθύνη ανάλογα με το πρόγραμμα που θα επιλεγεί. Πριν από την τελική παράδοση του οχήματος, η ομάδα μας επιβεβαιώνει ξανά τις καλύψεις, τις εξαιρέσεις και το ύψος της συμμετοχής. Δεν καλύπτονται περιστατικά που προκύπτουν από παραβίαση του ΚΟΚ, οδήγηση υπό επήρεια, μη εξουσιοδοτημένο οδηγό, απώλεια κλειδιών ή εγγράφων και χρήση του οχήματος εκτός των συμφωνημένων όρων. Οι πληροφορίες της σελίδας έχουν ενημερωτικό χαρακτήρα και υπερισχύουν οι τελικοί όροι που επιβεβαιώνονται από την εταιρία πριν την παραλαβή.',
  insuranceDetailsTitle: 'Λεπτομέρειες ασφαλιστικών επιλογών',
  insuranceDetailsIntro: 'Παρακάτω βλέπεις συνοπτικά τις επιλογές κάλυψης που χρησιμοποιούνται στο front booking flow.',
  insuranceDetailsBody: 'Το CDW αποτελεί τη βασική κάλυψη χωρίς επιπλέον ημερήσια χρέωση. Το SCDW μειώνει περαιτέρω την οικονομική έκθεση του οδηγού, ενώ το FULL παρέχει την πιο ενισχυμένη επιλογή προστασίας που εμφανίζεται στο backroom και στο booking flow. Για κάθε κράτηση, το τελικό πρόγραμμα ασφάλισης, οι χρεώσεις και οι εξαιρέσεις επιβεβαιώνονται από την ομάδα μας πριν από την παράδοση.',
  rentalTermsTitle: 'Όροι ενοικίασης και πολιτικές',
  rentalTermsIntro: 'Στην παρακάτω σελίδα συγκεντρώνονται βασικοί όροι, προϋποθέσεις και πολιτικές της ενοικίασης με μορφή εύκολη για ανάγνωση και ενημέρωση από το backroom.',
  rentalTermsBody: 'Η ενοικίαση ολοκληρώνεται μόνο μετά από επιβεβαίωση της διαθεσιμότητας από την εταιρία και έλεγχο των στοιχείων του οδηγού. Η εταιρία διατηρεί το δικαίωμα να προτείνει ισοδύναμο όχημα ίδιας ή ανώτερης κατηγορίας όταν αυτό απαιτηθεί από λειτουργικούς λόγους, χωρίς πρόσθετη χρέωση για τον πελάτη.',
  rentalRequirementsBody: 'Ο κύριος οδηγός οφείλει να διαθέτει ισχύουσα άδεια οδήγησης, ταυτότητα ή διαβατήριο και κάρτα ή άλλο μέσο πληρωμής αποδεκτό από την εταιρία. Ελάχιστη ηλικία, έτη κατοχής διπλώματος, εγγύηση και τυχόν επασφάλιστρα εξαρτώνται από την κατηγορία οχήματος και την τελική επιβεβαίωση της κράτησης.',
  rentalPoliciesBody: 'Η πολιτική καυσίμου, οι ώρες παράδοσης και παραλαβής, οι χρεώσεις εκτός ωραρίου, οι ακυρώσεις, οι καθυστερήσεις και οι όροι επέκτασης της μίσθωσης επιβεβαιώνονται πριν την παράδοση. Τυχόν ζημιές, πρόστιμα, απώλειες εξοπλισμού ή χρήση του οχήματος κατά παράβαση των συμφωνημένων όρων βαρύνουν τον ενοικιαστή σύμφωνα με την τελική σύμβαση.',
  rentalPrivacyBody: 'Τα προσωπικά δεδομένα χρησιμοποιούνται αποκλειστικά για την εξυπηρέτηση της κράτησης, την επικοινωνία με τον πελάτη και την εκπλήρωση νομικών ή φορολογικών υποχρεώσεων της εταιρίας. Για ειδικά αιτήματα, διορθώσεις στοιχείων ή απορίες σχετικά με την επεξεργασία δεδομένων, ο πελάτης μπορεί να επικοινωνεί με την εταιρία στα διαθέσιμα στοιχεία επικοινωνίας.',
  active: true
};

export const INSURANCE_OPTIONS = [
  {
    key: 'cdw',
    label: 'CDW',
    pricePerDay: 0,
    description: 'Βασική ασφαλιστική επιλογή χωρίς επιπλέον ημερήσια χρέωση.',
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 10
  },
  {
    key: 'scdw',
    label: 'SCDW',
    pricePerDay: 12,
    description: 'Μειωμένη ευθύνη με ημερήσια χρέωση.',
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 20
  },
  {
    key: 'full',
    label: 'FULL',
    pricePerDay: 20,
    description: 'Πλήρης κάλυψη με υψηλότερη ημερήσια χρέωση.',
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 30
  }
];

export const EXTRA_OPTIONS = [
  {
    key: 'baby',
    label: 'Βρεφικό κάθισμα',
    price: 5,
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 10
  },
  {
    key: 'child',
    label: 'Παιδικό κάθισμα',
    price: 5,
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 20
  },
  {
    key: 'booster',
    label: 'Booster',
    price: 5,
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 30
  },
  {
    key: 'secondDriver',
    label: 'Δεύτερος οδηγός',
    price: 7,
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 40
  },
  {
    key: 'gps',
    label: 'GPS',
    price: 8,
    billingMode: 'perDay',
    active: true,
    publicVisible: true,
    sortOrder: 50
  }
];

export const FEE_RULES = [
  {
    key: 'youngDriver',
    label: 'Επασφάλιστρο ηλικίας 19-22',
    ruleType: 'ageRange',
    audienceGroup: '19-22',
    amount: 16,
    billingMode: 'perBooking',
    active: true,
    publicVisible: true,
    sortOrder: 10
  },
  {
    key: 'seniorDriver',
    label: 'Επασφάλιστρο ηλικίας 70+',
    ruleType: 'ageRange',
    audienceGroup: '70+',
    amount: 10,
    billingMode: 'perBooking',
    active: true,
    publicVisible: true,
    sortOrder: 20
  },
  {
    key: 'nightPickup',
    label: 'Νυχτερινή χρέωση παραλαβής',
    ruleType: 'nightPickup',
    amount: 15,
    billingMode: 'perBooking',
    active: true,
    publicVisible: true,
    sortOrder: 30
  },
  {
    key: 'nightDropoff',
    label: 'Νυχτερινή χρέωση επιστροφής',
    ruleType: 'nightDropoff',
    amount: 15,
    billingMode: 'perBooking',
    active: true,
    publicVisible: true,
    sortOrder: 40
  },
  {
    key: 'adminFee',
    label: 'Λοιπή χρέωση',
    ruleType: 'manual',
    amount: 0,
    billingMode: 'perBooking',
    active: true,
    publicVisible: false,
    sortOrder: 200
  }
];

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function text(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

export function getInsuranceMap(plans = INSURANCE_OPTIONS) {
  return (Array.isArray(plans) ? plans : INSURANCE_OPTIONS).reduce((acc, item) => {
    const key = text(item?.key || item?.code || item?.slug, '').toLowerCase();
    if (!key) return acc;
    acc[key] = toNumber(item?.pricePerDay ?? item?.price, 0);
    return acc;
  }, {});
}

export function getExtraConfigMap(extras = EXTRA_OPTIONS) {
  return (Array.isArray(extras) ? extras : EXTRA_OPTIONS).reduce((acc, item) => {
    const key = text(item?.key || item?.code || item?.slug, '');
    if (!key) return acc;
    acc[key] = {
      key,
      price: toNumber(item?.price ?? item?.pricePerDay, 0),
      billingMode: text(item?.billingMode || item?.mode, 'perDay') === 'perBooking' ? 'perBooking' : 'perDay',
      label: text(item?.label || item?.title || key, key),
      _id: text(item?._id, '')
    };
    return acc;
  }, {});
}

export function getFallbackPricingCatalog() {
  return {
    businessSettings: { ...DEFAULT_BUSINESS_SETTINGS },
    insurancePlans: INSURANCE_OPTIONS.map((item) => ({ ...item })),
    extraServices: EXTRA_OPTIONS.map((item) => ({ ...item })),
    feeRules: FEE_RULES.map((item) => ({ ...item }))
  };
}
