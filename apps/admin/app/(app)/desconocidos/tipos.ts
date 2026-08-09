export interface RespuestaIA {
  reconocido: boolean;
  nombre: string;
  laboratorio: string;
  concentracion: string;
  contenido: number;
  unidad: string;
  confianza: number;
}

export type EstadoDesconocido = "pendiente_ia" | "sugerido" | "no_reconocido" | "resuelto";

export interface DesconocidoItem {
  id: string;
  codigo_norm: string;
  codigo_raw: string;
  foto_path: string | null;
  estado: EstadoDesconocido;
  ia_respuesta: RespuestaIA | null;
  ia_confianza: number | null;
  created_at: string;
  sucursalIds: string[];
  conteoIds: string[];
}

export interface OpcionSimple {
  id: string;
  nombre: string;
}
