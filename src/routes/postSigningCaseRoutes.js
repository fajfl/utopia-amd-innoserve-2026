const service = require('../services/postSigningCaseService');
function register(router, { withDriver, viewerId, lineClient }) {
  const base='/v2/api/contracts/:contractPublicId/assistant/cases';
  function handle(method) { return async (req,res,next)=>{
    res.setHeader('Cache-Control','private, no-store');
    try { const result=await withDriver(db=>service[method]({ ...req.body, db, lineUserId:viewerId(req), contractPublicId:req.params.contractPublicId, caseId:req.params.caseId, role:req.method==='GET' ? req.query.role : req.body.role, lineClient })); res.json(result); }
    catch(error){ if(error.statusCode) return res.status(error.statusCode).json({error:error.message}); next(error); }
  }; }
  router.post(`${base}/photos`,handle('upload'));
  router.get(`${base}/photos/:photoId`,async (req,res,next)=>{
    try { const file=await withDriver(db=>service.photo({db,lineUserId:viewerId(req),contractPublicId:req.params.contractPublicId,role:req.query.role,photoId:req.params.photoId}));
      res.set({'Content-Type':file.mimeType,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'private, no-store'}); res.send(file.bytes);
    } catch(error) { if(error.statusCode) return res.status(error.statusCode).json({error:error.message}); next(error); }
  });
  router.post(`${base}/preview`,handle('preview'));
  router.post(base,handle('create'));
  router.get(base,handle('list'));
  router.get(`${base}/:caseId`,handle('get'));
  router.post(`${base}/:caseId/events`,handle('event'));
  router.post(`${base}/:caseId/retry-notification`,handle('retry'));
}
module.exports={register};
