/** Pounds per unit, for warehouse systems that report weight with a unit name. */
export const TO_LB: Record<string, number> = {
  oz: 1 / 16,
  ounce: 1 / 16,
  ounces: 1 / 16,
  lb: 1,
  lbs: 1,
  pound: 1,
  pounds: 1,
  g: 1 / 453.59237,
  gram: 1 / 453.59237,
  grams: 1 / 453.59237,
  kg: 2.20462262,
  kilogram: 2.20462262,
  kilograms: 2.20462262,
};
