// Tipos manuales para las tablas creadas en Fase 0 (tenancy base).
// Cuando el proyecto de Supabase esté conectado y la migración aplicada,
// reemplazar este archivo generándolo con:
//   pnpm supabase gen types typescript --project-id <id> > packages/db/src/types/database.types.ts
// No editar a mano después de generado.

export type Rol = "superadmin" | "gerente" | "admin" | "operario";

export interface Database {
  public: {
    Tables: {
      empresas: {
        Row: {
          id: string;
          nombre: string;
          nit: string | null;
          pais: string | null;
          telefono: string | null;
          email: string | null;
          direccion: string | null;
          ciudad: string | null;
          contacto_emergencia_nombre: string | null;
          contacto_emergencia_telefono: string | null;
          config: Record<string, unknown>;
          activo: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          nombre: string;
          nit?: string | null;
          pais?: string | null;
          telefono?: string | null;
          email?: string | null;
          direccion?: string | null;
          ciudad?: string | null;
          contacto_emergencia_nombre?: string | null;
          contacto_emergencia_telefono?: string | null;
          config?: Record<string, unknown>;
          activo?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["empresas"]["Insert"]>;
        Relationships: [];
      };
      sucursales: {
        Row: {
          id: string;
          empresa_id: string;
          nombre: string;
          direccion: string | null;
          activo: boolean;
        };
        Insert: {
          id?: string;
          empresa_id: string;
          nombre: string;
          direccion?: string | null;
          activo?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["sucursales"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "sucursales_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
        ];
      };
      perfiles: {
        Row: {
          id: string;
          nombre: string;
          empresa_id: string;
          rol: Rol;
          activo: boolean;
        };
        Insert: {
          id: string;
          nombre: string;
          empresa_id: string;
          rol: Rol;
          activo?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["perfiles"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "perfiles_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
        ];
      };
      perfiles_sucursal: {
        Row: {
          perfil_id: string;
          sucursal_id: string;
        };
        Insert: {
          perfil_id: string;
          sucursal_id: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["perfiles_sucursal"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "perfiles_sucursal_perfil_id_fkey";
            columns: ["perfil_id"];
            isOneToOne: false;
            referencedRelation: "perfiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "perfiles_sucursal_sucursal_id_fkey";
            columns: ["sucursal_id"];
            isOneToOne: false;
            referencedRelation: "sucursales";
            referencedColumns: ["id"];
          },
        ];
      };
      laboratorios: {
        Row: {
          id: string;
          nombre: string;
        };
        Insert: {
          id?: string;
          nombre: string;
        };
        Update: Partial<Database["public"]["Tables"]["laboratorios"]["Insert"]>;
        Relationships: [];
      };
      productos: {
        Row: {
          id: string;
          nombre: string;
          laboratorio_id: string | null;
          principio_activo: string | null;
          concentracion: string | null;
          forma: string | null;
          contenido: number | null;
          unidad: string | null;
          requiere_receta: boolean;
          controlado: boolean;
          origen: "manual" | "ia" | "importado";
          activo: boolean;
          categoria: string | null;
          creado_por: string | null;
          actualizado_por: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          nombre: string;
          laboratorio_id?: string | null;
          principio_activo?: string | null;
          concentracion?: string | null;
          forma?: string | null;
          contenido?: number | null;
          unidad?: string | null;
          requiere_receta?: boolean;
          controlado?: boolean;
          origen?: "manual" | "ia" | "importado";
          activo?: boolean;
          categoria?: string | null;
          creado_por?: string | null;
          actualizado_por?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["productos"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "productos_laboratorio_id_fkey";
            columns: ["laboratorio_id"];
            isOneToOne: false;
            referencedRelation: "laboratorios";
            referencedColumns: ["id"];
          },
        ];
      };
      codigos_barra: {
        Row: {
          id: string;
          producto_id: string;
          codigo_norm: string;
          codigo_raw: string;
          tipo: "EAN13" | "UPCA" | "GTIN14" | "DATAMATRIX" | "GS1-128" | null;
          es_principal: boolean;
          unidades_por_codigo: number;
        };
        Insert: {
          id?: string;
          producto_id: string;
          codigo_norm: string;
          codigo_raw: string;
          tipo?: "EAN13" | "UPCA" | "GTIN14" | "DATAMATRIX" | "GS1-128" | null;
          es_principal?: boolean;
          unidades_por_codigo?: number;
        };
        Update: Partial<Database["public"]["Tables"]["codigos_barra"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "codigos_barra_producto_id_fkey";
            columns: ["producto_id"];
            isOneToOne: false;
            referencedRelation: "productos";
            referencedColumns: ["id"];
          },
        ];
      };
      productos_empresa: {
        Row: {
          empresa_id: string;
          producto_id: string;
          costo: number | null;
          precio: number | null;
          stock_minimo: number | null;
          codigo_proveedor: string | null;
          activo: boolean;
        };
        Insert: {
          empresa_id: string;
          producto_id: string;
          costo?: number | null;
          precio?: number | null;
          stock_minimo?: number | null;
          codigo_proveedor?: string | null;
          activo?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["productos_empresa"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "productos_empresa_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "productos_empresa_producto_id_fkey";
            columns: ["producto_id"];
            isOneToOne: false;
            referencedRelation: "productos";
            referencedColumns: ["id"];
          },
        ];
      };
      conteos: {
        Row: {
          id: string;
          empresa_id: string;
          sucursal_id: string;
          bodega_id: string | null;
          nombre: string;
          tipo: "total" | "parcial";
          estado: "abierto" | "cerrado";
          iniciado_por: string;
          iniciado_at: string;
          cerrado_at: string | null;
          cerrado_por: string | null;
        };
        Insert: {
          id?: string;
          empresa_id: string;
          sucursal_id: string;
          bodega_id?: string | null;
          nombre: string;
          tipo?: "total" | "parcial";
          estado?: "abierto" | "cerrado";
          iniciado_por: string;
          iniciado_at?: string;
          cerrado_at?: string | null;
          cerrado_por?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["conteos"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "conteos_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conteos_sucursal_id_fkey";
            columns: ["sucursal_id"];
            isOneToOne: false;
            referencedRelation: "sucursales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conteos_bodega_id_fkey";
            columns: ["bodega_id"];
            isOneToOne: false;
            referencedRelation: "bodegas";
            referencedColumns: ["id"];
          },
        ];
      };
      conteo_lineas: {
        Row: {
          id: string;
          conteo_id: string;
          producto_id: string | null;
          desconocido_id: string | null;
          cantidad: number;
          notas: string | null;
        };
        Insert: {
          id?: string;
          conteo_id: string;
          producto_id?: string | null;
          desconocido_id?: string | null;
          cantidad?: number;
          notas?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["conteo_lineas"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "conteo_lineas_conteo_id_fkey";
            columns: ["conteo_id"];
            isOneToOne: false;
            referencedRelation: "conteos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conteo_lineas_producto_id_fkey";
            columns: ["producto_id"];
            isOneToOne: false;
            referencedRelation: "productos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conteo_lineas_desconocido_id_fkey";
            columns: ["desconocido_id"];
            isOneToOne: false;
            referencedRelation: "desconocidos";
            referencedColumns: ["id"];
          },
        ];
      };
      desconocidos: {
        Row: {
          id: string;
          empresa_id: string;
          codigo_norm: string;
          codigo_raw: string;
          foto_path: string | null;
          estado: "pendiente_ia" | "sugerido" | "no_reconocido" | "resuelto";
          ia_respuesta: Json | null;
          ia_confianza: number | null;
          ia_intentos: number;
          producto_resuelto_id: string | null;
          revisado_por: string | null;
          revisado_at: string | null;
          detectado_por: string;
          conteo_deteccion_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          empresa_id: string;
          codigo_norm: string;
          codigo_raw: string;
          foto_path?: string | null;
          estado?: "pendiente_ia" | "sugerido" | "no_reconocido" | "resuelto";
          ia_respuesta?: Json | null;
          ia_confianza?: number | null;
          ia_intentos?: number;
          producto_resuelto_id?: string | null;
          revisado_por?: string | null;
          revisado_at?: string | null;
          detectado_por: string;
          conteo_deteccion_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["desconocidos"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "desconocidos_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "desconocidos_conteo_deteccion_id_fkey";
            columns: ["conteo_deteccion_id"];
            isOneToOne: false;
            referencedRelation: "conteos";
            referencedColumns: ["id"];
          },
        ];
      };
      bodegas: {
        Row: {
          id: string;
          empresa_id: string;
          sucursal_id: string;
          nombre: string;
          activo: boolean;
        };
        Insert: {
          id?: string;
          empresa_id: string;
          sucursal_id: string;
          nombre: string;
          activo?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["bodegas"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "bodegas_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bodegas_sucursal_id_fkey";
            columns: ["sucursal_id"];
            isOneToOne: false;
            referencedRelation: "sucursales";
            referencedColumns: ["id"];
          },
        ];
      };
      lotes: {
        Row: {
          id: string;
          empresa_id: string;
          sucursal_id: string;
          bodega_id: string | null;
          producto_id: string;
          lote: string | null;
          vencimiento: string;
          cantidad: number;
          actualizado_en_conteo_id: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          empresa_id: string;
          sucursal_id: string;
          bodega_id?: string | null;
          producto_id: string;
          lote?: string | null;
          vencimiento: string;
          cantidad?: number;
          actualizado_en_conteo_id?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["lotes"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "lotes_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lotes_sucursal_id_fkey";
            columns: ["sucursal_id"];
            isOneToOne: false;
            referencedRelation: "sucursales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lotes_bodega_id_fkey";
            columns: ["bodega_id"];
            isOneToOne: false;
            referencedRelation: "bodegas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lotes_producto_id_fkey";
            columns: ["producto_id"];
            isOneToOne: false;
            referencedRelation: "productos";
            referencedColumns: ["id"];
          },
        ];
      };
      mapeos_columnas: {
        Row: {
          id: string;
          empresa_id: string;
          nombre: string;
          mapeo: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          empresa_id: string;
          nombre: string;
          mapeo: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["mapeos_columnas"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "mapeos_columnas_empresa_id_fkey";
            columns: ["empresa_id"];
            isOneToOne: false;
            referencedRelation: "empresas";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      mi_empresa_id: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      mi_rol: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      tengo_acceso_sucursal: {
        Args: { p_sucursal: string };
        Returns: boolean;
      };
      normalizar_codigo: {
        Args: { p_codigo: string };
        Returns: { codigo_norm: string | null; lote: string | null; vencimiento: string | null };
      };
      buscar_producto: {
        Args: { p_empresa: string; p_codigo: string };
        Returns: Json | null;
      };
      registrar_escaneos_batch: {
        Args: { p_conteo: string; p_escaneos: Json };
        Returns: Json;
      };
      resumen_conteo: {
        Args: { p_conteo: string };
        Returns: Json;
      };
      cerrar_conteo: {
        Args: { p_conteo_id: string };
        Returns: Json;
      };
      comparar_conteo: {
        Args: { p_conteo_id: string };
        Returns: Json;
      };
      actualizar_datos_contacto_empresa: {
        Args: {
          p_nombre: string;
          p_telefono: string | null;
          p_email: string | null;
          p_direccion: string | null;
          p_ciudad: string | null;
          p_contacto_emergencia_nombre: string | null;
          p_contacto_emergencia_telefono: string | null;
        };
        Returns: Json;
      };
      iniciar_importacion: {
        Args: { p_archivo: string; p_mapeo: Json };
        Returns: string;
      };
      previsualizar_importacion: {
        Args: { p_laboratorio: string; p_filas: Json };
        Returns: Json;
      };
      confirmar_importacion_lote: {
        Args: { p_importacion_id: string; p_laboratorio: string; p_filas: Json };
        Returns: Json;
      };
      finalizar_importacion: {
        Args: { p_importacion_id: string };
        Returns: Json;
      };
      registrar_escaneo_desconocido: {
        Args: {
          p_conteo: string;
          p_codigo_raw: string;
          p_client_uuid: string;
          p_foto_path?: string | null;
          p_dispositivo?: string | null;
        };
        Returns: Json;
      };
      resolver_desconocido: {
        Args: {
          p_desconocido_id: string;
          p_producto_id?: string | null;
          p_nuevo_producto?: Json | null;
        };
        Returns: Json;
      };
      actualizar_usuario_superadmin: {
        Args: {
          p_perfil_id: string;
          p_nombre?: string | null;
          p_rol?: string | null;
          p_activo?: boolean | null;
          p_sucursal_ids?: string[] | null;
        };
        Returns: undefined;
      };
    };
  };
}

// Tipo mínimo de lo que Postgres/PostgREST llama "json" — evita usar
// `any` en las funciones de arriba sin declarar cada tabla nueva del
// esquema completo acá (eso queda para cuando se genere el archivo real
// con `supabase gen types`).
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];
