import { describe, expect, it } from 'vitest';
import { extractFeatures, findEuroAmount, parseArea, parseAvailableFrom, parseDateValue, parsePrice, parseTypology } from '../src/core/text.js';

const NOW = new Date('2026-11-14T12:00:00Z');
const f = (title: string, body = '') => extractFeatures(title, body, NOW);

describe('parsePrice', () => {
  it.each([
    ['830 €/mês', 830],
    ['1.200 €', 1200],
    ['1 250€', 1250],
    ['€1,300', 1300],
    ['950,50 €', 950.5],
    ['Preço sob consulta', null],
    ['', null],
  ])('%s -> %s', (text, want) => expect(parsePrice(text)).toBe(want));
});

describe('findEuroAmount', () => {
  it.each([
    ['T2 900€ Gaia', 900],
    ['Apartamento T3 1.250 € /mês', 1250],
    ['renda 1 100 € com despesas', 1100],
    ['EUR 950 por mês', 950],
    ['T2 com 80 m2', null],
  ])('%s -> %s', (text, want) => expect(findEuroAmount(text)).toBe(want));
});

describe('parseTypology', () => {
  it.each([
    ['Apartamento T2 em Paranhos', 2],
    ['t3 duplex', 3],
    ['T2+1 com varanda', 2],
    ['T 1 renovado', 1],
    ['Estúdio no centro', 0],
    ['Apartamento no centro', null],
    ['Rua T10 lote', null],
    ['Lote 3', null],
  ])('%s -> %s', (text, want) => expect(parseTypology(text)).toBe(want));
});

describe('parseArea', () => {
  it('reads m² and m2', () => {
    expect(parseArea('38 m²')).toBe(38);
    expect(parseArea('área de 72,5 m2')).toBe(72.5);
    expect(parseArea('3 minutos do metro')).toBeNull();
  });
});

describe('dates', () => {
  it('parses explicit dates', () => {
    expect(parseDateValue('01.01.2027', NOW)).toBe('2027-01-01');
    expect(parseDateValue('15/12/2026', NOW)).toBe('2026-12-15');
    expect(parseDateValue('2027-02-01', NOW)).toBe('2027-02-01');
  });
  it('assumes the next occurrence of a month given without a year', () => {
    expect(parseDateValue('Janeiro', NOW)).toBe('2027-01-01');
    expect(parseDateValue('1 de dezembro', NOW)).toBe('2026-12-01');
  });
  it('finds availability phrases in free text', () => {
    expect(parseAvailableFrom('Disponível a partir de 1 de janeiro de 2027.', NOW)).toBe('2027-01-01');
    expect(parseAvailableFrom('Apartamento disponível em Janeiro', NOW)).toBe('2027-01-01');
    expect(parseAvailableFrom('Disponibilidade imediata', NOW)).toBe('2026-11-14');
    expect(parseAvailableFrom('Disponível para visitas ao sábado', NOW)).toBeNull();
    expect(parseAvailableFrom('T2 com varanda', NOW)).toBeNull();
  });
});

describe('extractFeatures', () => {
  it('says nothing when the text says nothing', () => {
    expect(f('Apartamento T2 em Mafamude')).toEqual({
      furnished: null, garage: null, outdoor: null, elevator: null, shortTerm: null, sharedRoom: null, registration: null, availableFrom: null,
    });
  });
  it('reads furnishing, including negations and kitchen-only statements', () => {
    expect(f('T2 mobilado').furnished).toBe('yes');
    expect(f('T2', 'Totalmente mobilado e equipado').furnished).toBe('yes');
    expect(f('T2', 'Apartamento não mobilado').furnished).toBe('no');
    expect(f('T2 sem mobília').furnished).toBe('no');
    expect(f('T2 semi-mobilado').furnished).toBe('partial');
    expect(f('T2', 'Cozinha mobilada e equipada, roupeiros embutidos').furnished).toBe('partial');
    expect(f('T2', 'equipamento: frigorífico, mobiliário').furnished).toBe('yes');
  });
  it('reads garage and outdoor space without being fooled by street parking or place names', () => {
    expect(f('T2 com lugar de garagem').garage).toBe(true);
    expect(f('T2', 'Sem garagem').garage).toBe(false);
    expect(f('T2', 'Fácil estacionamento na rua').garage).toBeNull();
    expect(f('T2 com varanda').outdoor).toBe(true);
    expect(f('T2', 'terraço de 20 m2').outdoor).toBe(true);
    expect(f('T2 junto ao Jardim do Morro').outdoor).toBeNull();
    expect(f('T2', 'sem varanda').outdoor).toBe(false);
  });
  it('detects short-term rentals', () => {
    expect(f('T1 arrendamento de curta duração').shortTerm).toBe(true);
    expect(f('T2', 'Disponível apenas até junho').shortTerm).toBe(true);
    expect(f('T2', 'Contrato de 6 meses').shortTerm).toBe(true);
    expect(f('T2 para férias').shortTerm).toBe(true);
    expect(f('T2', 'Contrato de 1 ano renovável').shortTerm).toBe(false);
    expect(f('T2', 'Arrendamento de longa duração').shortTerm).toBe(false);
    expect(f('T2', 'A 5 minutos a pé do metro').shortTerm).toBeNull();
  });
  it('detects rooms and shared flats but not bedrooms inside a flat', () => {
    expect(f('Quarto para estudante em Paranhos').sharedRoom).toBe(true);
    expect(f('Arrenda-se quarto individual').sharedRoom).toBe(true);
    expect(f('T3', 'quarto em apartamento partilhado').sharedRoom).toBe(true);
    expect(f('T2 com 2 quartos e sala').sharedRoom).toBeNull();
    expect(f('T2', 'Dois quartos com roupeiro, quarto de banho completo').sharedRoom).toBeNull();
  });
  it('reads contract/registration statements', () => {
    expect(f('T2', 'Com contrato de arrendamento e recibos').registration).toBe(true);
    expect(f('T2', 'Possibilidade de morada fiscal').registration).toBe(true);
    expect(f('T2', 'Sem contrato').registration).toBe(false);
    expect(f('T2', 'Não se passa recibos').registration).toBe(false);
  });
});
