// El libro del gasto en la API de Claude: cuánto va el mes y cuántas veces usó cada persona cada función hoy. Vive en
// el Durable Object del juego porque ahí los pedidos se atienden de a uno: dos personas a la vez no pueden pasarse del
// tope leyendo la misma cifra vieja (en la KV sí podrían). Antes de llamar a la API se «reserva» un pedido, con un
// monto apartado; al terminar se cierra con lo que costó de verdad.

import { isoDate } from '../lib/num';
import type { GameStorage } from './juego';

const LIMA = 'America/Lima';

export type IaTipo = 'reporte' | 'ficha' | 'chat';
export const IA_TIPOS: IaTipo[] = ['reporte', 'ficha', 'chat'];

export interface IaLimites {
  /** Tope de gasto del mes, en US$, entre todos y todas las funciones. */
  mesUsd: number;
  /** Tope del mes de cada función (su suma puede pasar del total: manda el total). */
  tipoUsd: Record<IaTipo, number>;
  /** Usos por persona y por día (fecha de Lima). */
  porDia: Record<IaTipo, number>;
  /** Lo que se aparta por un pedido en curso, hasta saber lo que costó de verdad: lo máximo que debería costar. */
  reservaUsd: Record<IaTipo, number>;
}

export type IaMotivo = 'dia' | 'mes' | 'tipo' | 'en-curso';
export type IaReserva = { ok: true; id: string } | { ok: false; motivo: IaMotivo };

export interface IaEstado {
  /** Usos de hoy de quien pregunta. */
  hoy: Record<IaTipo, number>;
  /** Gasto del mes de todos, en US$ (con lo apartado por los pedidos en curso). */
  mes: { usd: number; tipo: Record<IaTipo, number>; usos: Record<IaTipo, number> };
}

interface Mes {
  usd: number;
  tipo: Record<IaTipo, number>;
  usos: Record<IaTipo, number>;
}

interface Curso {
  pid: string;
  tipo: IaTipo;
  dia: string;
  usd: number;
  /** Para no hacer dos veces el mismo trabajo a la vez (leer el mismo reporte). */
  clave: string | null;
  at: number;
}

/** Un pedido que no se cerró en este tiempo (el Worker murió a la mitad) se da por gastado a lo que apartó. */
const CURSO_MS = 10 * 60_000;
/** Los contadores por día se borran pasado este tiempo. */
const DIAS_GUARDADOS = 3;
const EPS = 1e-9;

const cero = (): Record<IaTipo, number> => ({ reporte: 0, ficha: 0, chat: 0 });
const K_MES = (dia: string) => `ia:mes:${dia.slice(0, 7)}`;
const K_DIA = (dia: string, pid: string) => `ia:dia:${dia}:${pid}`;
const K_CURSO = (id: string) => `ia:curso:${id}`;

export class LibroIA {
  constructor(private readonly store: GameStorage) {}

  private async mes(dia: string): Promise<Mes> {
    const m = await this.store.get<Mes>(K_MES(dia));
    return { usd: m?.usd ?? 0, tipo: { ...cero(), ...m?.tipo }, usos: { ...cero(), ...m?.usos } };
  }

  private async sumar(dia: string, tipo: IaTipo, usd: number): Promise<void> {
    const m = await this.mes(dia);
    m.usd += usd;
    m.tipo[tipo] += usd;
    m.usos[tipo] += 1;
    await this.store.put(K_MES(dia), m);
  }

  /** Los pedidos en curso. De paso, los que quedaron colgados se dan por gastados y se limpian los contadores viejos. */
  private async vivos(now: Date): Promise<Curso[]> {
    const out: Curso[] = [];
    for (const [key, c] of await this.store.list<Curso>({ prefix: 'ia:curso:' })) {
      if (now.getTime() - c.at <= CURSO_MS) out.push(c);
      else {
        await this.store.delete(key);
        await this.sumar(c.dia, c.tipo, c.usd);
      }
    }
    const viejo = isoDate(new Date(now.getTime() - DIAS_GUARDADOS * 86_400_000), LIMA);
    for (const key of (await this.store.list({ prefix: 'ia:dia:' })).keys()) {
      if (key.slice('ia:dia:'.length, 'ia:dia:'.length + 10) < viejo) await this.store.delete(key);
    }
    return out;
  }

  /**
   * Anota un pedido si entra en los topes: el del día de esa persona y los del mes (el total y el de la función),
   * contando lo que ya apartaron los pedidos en curso. Con `clave`, no deja empezar dos veces el mismo trabajo.
   */
  async reservar(pid: string, tipo: IaTipo, now: Date, lim: IaLimites, clave: string | null = null): Promise<IaReserva> {
    const dia = isoDate(now, LIMA);
    const cursos = await this.vivos(now);
    if (clave && cursos.some((c) => c.clave === clave)) return { ok: false, motivo: 'en-curso' };
    // Lo apartado cuenta contra el mes en que se pidió.
    const delMes = cursos.filter((c) => c.dia.slice(0, 7) === dia.slice(0, 7));
    const apartado = (t?: IaTipo) => delMes.filter((c) => !t || c.tipo === t).reduce((s, c) => s + c.usd, 0);
    const m = await this.mes(dia);
    const pide = lim.reservaUsd[tipo];
    // Con un margen mínimo: sumar centavos en binario da 0,30000000000000004.
    if (m.usd + apartado() + pide > lim.mesUsd + EPS) return { ok: false, motivo: 'mes' };
    if (m.tipo[tipo] + apartado(tipo) + pide > lim.tipoUsd[tipo] + EPS) return { ok: false, motivo: 'tipo' };
    const hoy = { ...cero(), ...(await this.store.get<Record<IaTipo, number>>(K_DIA(dia, pid))) };
    if (hoy[tipo] >= lim.porDia[tipo]) return { ok: false, motivo: 'dia' };
    hoy[tipo] += 1;
    await this.store.put(K_DIA(dia, pid), hoy);
    const id = crypto.randomUUID();
    await this.store.put<Curso>(K_CURSO(id), { pid, tipo, dia, usd: pide, clave, at: now.getTime() });
    return { ok: true, id };
  }

  /** Cierra un pedido con lo que costó. `null`: falló sin gastar nada, y a la persona se le devuelve el uso del día. */
  async cerrar(id: string, usd: number | null): Promise<void> {
    const c = await this.store.get<Curso>(K_CURSO(id));
    if (!c) return;
    await this.store.delete(K_CURSO(id));
    if (usd !== null) return this.sumar(c.dia, c.tipo, usd);
    const hoy = { ...cero(), ...(await this.store.get<Record<IaTipo, number>>(K_DIA(c.dia, c.pid))) };
    hoy[c.tipo] = Math.max(0, hoy[c.tipo] - 1);
    await this.store.put(K_DIA(c.dia, c.pid), hoy);
  }

  async estado(pid: string, now: Date): Promise<IaEstado> {
    const dia = isoDate(now, LIMA);
    const cursos = (await this.vivos(now)).filter((c) => c.dia.slice(0, 7) === dia.slice(0, 7));
    const m = await this.mes(dia);
    for (const c of cursos) {
      m.usd += c.usd;
      m.tipo[c.tipo] += c.usd;
    }
    return { hoy: { ...cero(), ...(await this.store.get<Record<IaTipo, number>>(K_DIA(dia, pid))) }, mes: m };
  }
}
