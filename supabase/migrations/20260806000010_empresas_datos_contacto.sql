-- A pedido del usuario tras ver el formulario "Nueva empresa" del panel de
-- superadmin: el spec original solo pedía nombre/nit/pais para `empresas`,
-- pero en uso real hace falta poder ubicar y contactar a la empresa (y a
-- alguien de urgencia) sin ir a buscarlo a otro lado. Todo nullable — nada
-- de esto es requisito para operar el sistema, son datos de contacto.

alter table empresas
  add column telefono text,
  add column email text,
  add column direccion text,
  add column ciudad text,
  add column contacto_emergencia_nombre text,
  add column contacto_emergencia_telefono text;
