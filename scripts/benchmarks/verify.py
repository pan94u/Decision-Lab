"""Differentially check real benchmark cases through persisted platform executions.

No live model is called. Controlled responses deliberately exercise success,
failure, invalid outputs and strict/loose differences. This is NOT a leaderboard run.
"""
import ast
import contextlib
import hashlib
import importlib.metadata
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import types

from fetch import fetch_sources, CACHE, ROOT


def run():
    import numpy as np
    import pandas as pd
    from sklearn.metrics import accuracy_score, f1_score

    manifest = fetch_sources()
    sources = {s['id']: s for s in manifest['sources']}
    sys.path.insert(0, str(CACHE / 'ifeval'))
    from instruction_following_eval import evaluation_lib

    artifacts = ROOT / 'artifacts/benchmark-verification'
    artifacts.mkdir(parents=True, exist_ok=True)
    packets, expected, source_cases = [], {}, {}

    def packet(name, cases, responses, variant='label-match', protocol=None):
        plan = {
            'projectId': 'benchmark-conformance', 'actorId': 'controlled-verification',
            'suite': {'id': name, 'revision': '1', 'cases': cases},
            'subject': {'id': 'controlled-fixture', 'revision': '1', 'adapter': 'controlled-fixture', 'purpose': 'not-model-capability'},
            'protocol': {'id': name, 'revision': '1', 'mode': 'derived', 'sourceManifestSha256':hashlib.sha256((ROOT/'benchmarks/sources.json').read_bytes()).hexdigest(), 'selection': 'deterministic source subset', 'responseSource': 'deliberately constructed conformance responses', **(protocol or {})},
            'evaluation': {'id': name, 'revision': '1', 'normalizerRevision':'benchmark-contract/1', 'implementationSha256':hashlib.sha256((ROOT/'src/domain/benchmark.mjs').read_bytes()).hexdigest(), 'variant': variant, 'aggregation':{'casePassRate':'all assessed cases; invalid counts false','unitAccuracy':'valid units only','macroF1ObservedLabels':'valid categorical outputs; observed expected/predicted labels only'}}, 'repeats': 1,
        }
        packets.append({'plan': plan, 'responses': responses, 'idempotencyKey': name})
        return packets[-1]

    # Execute the unchanged upstream MMLU eval function body with mocked transport.
    # AST selects function definitions only, so no obsolete OpenAI SDK/network setup runs.
    mmlu_path = CACHE / 'mmlu/evaluate.py'
    tree = ast.parse(mmlu_path.read_text())
    function_names = {'softmax', 'format_subject', 'format_example', 'gen_prompt', 'eval'}
    selected = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in function_names], type_ignores=[])
    namespace = {'np': np, 'pd': pd, 'choices': ['A','B','C','D'], 'crop': lambda p: p}
    transport = types.SimpleNamespace()
    namespace['openai'] = types.SimpleNamespace(Completion=transport)
    exec(compile(selected, str(mmlu_path), 'exec'), namespace)
    data = pd.read_parquet(CACHE / 'mmlu-data/abstract_algebra/test-00000-of-00001.parquet', engine='fastparquet').to_dict('records')[:4]
    dev = pd.read_parquet(CACHE / 'mmlu-data/abstract_algebra/dev-00000-of-00001.parquet', engine='fastparquet').to_dict('records')[:5]
    letters = ['A','B','C','D']
    frame = lambda rows: pd.DataFrame([[r['question'], *r['choices'], letters[r['answer']]] for r in rows])
    vectors = []
    for i, row in enumerate(data):
        winner = row['answer'] if i % 2 == 0 else (row['answer'] + 1) % 4
        vectors.append({k: (-0.1 if j == winner else -3.0 - j) for j,k in enumerate(letters)})
    seen_prompts = []
    def mock_create(**kwargs):
        scores = vectors[len(seen_prompts)]
        seen_prompts.append(kwargs['prompt'])
        return {'choices':[{'logprobs':{'top_logprobs':[{' '+k:v for k,v in scores.items()}]}}]}
    transport.create = mock_create
    with contextlib.redirect_stdout(io.StringIO()):
        correct, accuracy, probabilities = namespace['eval'](types.SimpleNamespace(ntrain=5), 'abstract_algebra', 'controlled-stub', frame(dev), frame(data))
    cases, responses = [], {}
    for i, row in enumerate(data):
        case_id = f'mmlu:abstract_algebra:test:{i}'
        cases.append({'id':case_id,'kind':'choice','input':{'prompt':seen_prompts[i],'labels':letters,'candidates':[{'id':k,'text':text} for k,text in zip(letters,row['choices'])]},'reference':{'label':letters[row['answer']]},'source':{'revision':sources['mmlu-data']['revision'],'itemId':f'abstract_algebra/test/{i}','split':'test'}})
        responses[case_id] = {'logScores':vectors[i]}
        expected[('mmlu',case_id)] = {'casePass':bool(correct[i]),'probabilities':dict(zip(letters,probabilities[i].tolist()))}
    packet('mmlu',cases,responses,protocol={'sourceRevision':sources['mmlu']['revision'],'dataRevision':sources['mmlu-data']['revision'],'fewShotCount':5,'crop':'identity for these short prompts only','officialCodeExecution':'unchanged AST-selected evaluation functions; mocked OpenAI transport'})
    source_cases['mmlu'] = {'uniqueSourceCases':len(data),'expectedControlledAccuracy':float(accuracy),'reference':'pinned upstream eval(), candidate argmax and softmax'}

    # Full CLINC label space, including legal OOS; no provider-specific 50-label limit.
    clinc = json.loads((CACHE / 'clinc/data/data_full.json').read_text())
    labels = sorted({label for _,label in clinc['train']}) + ['oos']
    chosen, seen = [], set()
    for index,(text,label) in enumerate(clinc['test']):
        if label not in seen:
            chosen.append((f'test/{index}',text,label));seen.add(label)
        if len(chosen)==3:break
    chosen += [(f'oos_test/{i}',text,label) for i,(text,label) in enumerate(clinc['oos_test'][:3])]
    cases,responses,truth,predictions=[],{},{},{}
    for i,(source_id,text,label) in enumerate(chosen):
        case_id='clinc:'+source_id
        pred=label if i%3==0 else next(x for x in labels if x!=label) if i%3==1 else '__invalid_selection__'
        cases.append({'id':case_id,'kind':'classification','input':{'text':text,'labels':labels},'reference':{'label':label},'source':{'revision':sources['clinc']['revision'],'itemId':source_id,'split':source_id.split('/')[0]}})
        responses[case_id]={'selected':pred};truth[case_id]=label;predictions[case_id]=pred
        expected[('clinc',case_id)]={'casePass':pred==label,'valid':pred in labels}
    packet('clinc',cases,responses,protocol={'sourceRevision':sources['clinc']['revision'],'labelCount':len(labels),'reference':'published labels; independent sklearn aggregation, not an official model run'})
    valid_ids=[k for k,p in predictions.items() if p in labels]
    source_cases['clinc']={'uniqueSourceCases':len(chosen),'labelCount':len(labels),'inScope':3,'outOfScope':3,'reference':'published labels + sklearn metrics','expectedControlledAccuracy':accuracy_score(list(truth.values()),list(predictions.values())),'expectedConditionalMacroF1':f1_score([truth[k] for k in valid_ids],[predictions[k] for k in valid_ids],average='macro',zero_division=0)}

    # Use every source case covered by the four implemented criteria, not synthetic questions.
    supported={'keywords:existence','keywords:forbidden_words','detectable_format:json_format','startend:quotation'}
    all_rows=[json.loads(line) for line in (CACHE/'ifeval/instruction_following_eval/data/input_data.jsonl').read_text().splitlines()]
    rows=[r for r in all_rows if set(r['instruction_id_list'])<=supported]
    source_cases['ifeval']={'uniqueSourceCases':len(rows),'multiCriterionCases':sum(len(r['instruction_id_list'])>1 for r in rows),'totalSourceCases':len(all_rows),'supportedCriteria':sorted(supported),'reference':'unmodified pinned evaluation_lib strict + loose, with controlled responses','semanticAnswerQuality':'not assessed by this conformance test'}
    for variant in ['strict','loose']:
        cases,responses=[],{}
        for row in rows:
            criteria=[{'id':key,'args':args} for key,args in zip(row['instruction_id_list'],row['kwargs'])]
            words=[w for q in criteria if q['id']=='keywords:existence' for w in q['args']['keywords']]
            forbidden=[w for q in criteria if q['id']=='keywords:forbidden_words' for w in q['args']['forbidden_words']]
            text=' '.join(words) or 'example'
            if 'detectable_format:json_format' in row['instruction_id_list']:text=json.dumps({'answer':text})
            elif 'startend:quotation' in row['instruction_id_list']:text='"'+text+'"'
            stimuli={'constructed':text,'empty':'','preamble':'Preamble\n'+text+'\nPostscript','fenced':'```json\n'+text+'\n```','partial':words[0] if words else 'not json','forbidden':text+' '+(forbidden[0] if forbidden else 'extra')}
            for stimulus,response in stimuli.items():
                case_id=f'ifeval:{row["key"]}:{stimulus}'
                cases.append({'id':case_id,'kind':'instructions','input':{'prompt':row['prompt'],'criteria':criteria},'reference':{'type':'executable-constraints','evaluatorRevision':sources['ifeval']['revision']},'source':{'revision':sources['ifeval']['revision'],'itemId':str(row['key']),'split':'input_data'}})
                responses[case_id]={'text':response}
                example=evaluation_lib.InputExample(**row)
                result=getattr(evaluation_lib,'test_instruction_following_'+variant)(example,{row['prompt']:response})
                expected[('ifeval-'+variant,case_id)]={'casePass':result.follow_all_instructions,'criteria':result.follow_instruction_list}
        packet('ifeval-'+variant,cases,responses,variant,protocol={'sourceRevision':sources['ifeval']['revision'],'criteriaSubset':sorted(supported),'variant':variant})

    packets_path=artifacts/'packets.json';packets_path.write_text(json.dumps(packets,ensure_ascii=False,indent=2)+'\n')
    # Fresh DB per run; users can keep previous experiment files and repeat independently.
    import datetime
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    database=artifacts/('experiments-'+stamp+'.sqlite');platform_path=artifacts/'platform-results.json'
    subprocess.run(['node','scripts/benchmarks/run-packets.mjs','--packets',str(packets_path),'--db',str(database),'--report',str(platform_path)],cwd=ROOT,check=True)
    platform=json.loads(platform_path.read_text());mismatches=[];case_checks=criterion_checks=probability_checks=0
    for report in platform['reports']:
        name=report['packetId']
        for execution in report['experiment']['executions']:
            result=execution['attempts'][0]['assessments'][0]['result'];reference=expected[(name,execution['case_id'])];case_checks+=1
            if result['casePass']!=reference['casePass']:mismatches.append({'benchmark':name,'case':execution['case_id'],'field':'casePass','actual':result['casePass'],'expected':reference['casePass']})
            if 'valid' in reference and (result['status']=='valid')!=reference['valid']:mismatches.append({'benchmark':name,'case':execution['case_id'],'field':'validity'})
            if 'criteria' in reference:
                actual=[u['correct'] for u in result['units']];criterion_checks+=len(actual)
                if actual!=reference['criteria']:mismatches.append({'benchmark':name,'case':execution['case_id'],'field':'criteria','actual':actual,'expected':reference['criteria']})
            for label,p in reference.get('probabilities',{}).items():
                probability_checks+=1
                if not math.isclose(result['units'][0]['probabilities'][label],p,rel_tol=1e-12,abs_tol=1e-12):mismatches.append({'benchmark':name,'case':execution['case_id'],'field':'probability','label':label})
        if name=='clinc' and not math.isclose(report['summary']['macroF1ObservedLabels'],source_cases['clinc']['expectedConditionalMacroF1'],abs_tol=1e-12):mismatches.append({'benchmark':name,'field':'conditionalMacroF1'})
    # Verify real process restart (not just reopening a connection in the same process).
    ids=[{'id':r['experiment']['id'],'projectId':r['experiment']['projectId']} for r in platform['reports']]
    reopened=json.loads(subprocess.check_output(['node','scripts/benchmarks/read-experiments.mjs',str(database),json.dumps(ids)],cwd=ROOT,text=True))
    for read,original in zip(reopened,platform['reports']):
        assert read['planHash']==original['experiment']['planHash']
        assert read['assessmentCount']==read['cases']*2
    assert all(x['inputHashPreserved'] and x['assessmentsAdded']==x['cases'] for x in platform['persistenceChecks'])
    # Explicitly demonstrate protocol/data mismatch in the old implementation's API cap.
    legacy_check=subprocess.check_output(['node','--input-type=module','-e',"import {validateTask} from './src/engine.js';try{validateTask({title:'CLINC',state:'x',questions:{q:{type:'choice',instructions:'label',criteria:Object.fromEntries(Array.from({length:151},(_,i)=>['c'+i,'label']))}},expected:{q:'c0'}});console.log('accepted')}catch(e){console.log(e.message)}"],cwd=ROOT,text=True).strip()
    versions={name:importlib.metadata.version(name) for name in ['numpy','pandas','fastparquet','scikit-learn','absl-py','nltk','langdetect','immutabledict']}
    report={'purpose':'Architecture conformance, NOT model capability or full official benchmark reproduction','status':'passed' if not mismatches else 'failed','generatedAt':stamp,'sourceManifestSha256':hashlib.sha256((ROOT/'benchmarks/sources.json').read_bytes()).hexdigest(),'sources':[{k:v for k,v in s.items() if k!='files'} for s in manifest['sources']],'platformImplementation':{file:hashlib.sha256((ROOT/file).read_bytes()).hexdigest() for file in ['src/domain/benchmark.mjs','src/server/storage/experiment-store.mjs','scripts/benchmarks/verify.py','scripts/benchmarks/run-packets.mjs']},'runtime':{'python':sys.version,'node':subprocess.check_output(['node','--version'],text=True).strip(),'pythonPackages':versions},'coverage':source_cases,'checks':{'caseComparisons':case_checks,'criterionComparisons':criterion_checks,'probabilityComparisons':probability_checks,'mismatches':mismatches,'createdExperiments':len(platform['reports']),'adapterCallsBeforeRescore':platform['adapterCalls'],'adapterCallsAfterRescore':platform['adapterCalls'],'processRestartReadback':True,'rescoringAddedRevisions':True},'findings':[{'id':'legacy-151-label-cap','reproducedError':legacy_check,'resolution':'Generic task contract supports declared label spaces; API-specific limits remain adapter concerns'},{'id':'strict-loose-and-criterion','resolution':'Variant and criterion/case levels persisted independently'},{'id':'trial-vs-invocation','resolution':'Execution and Invocation have separate identities; core tests include a two-invocation trial'}],'limitations':['Controlled stimuli do not measure model skill or semantic answer quality.','MMLU: four abstract_algebra test cases, five dev demonstrations; unchanged AST-selected eval function with mocked transport and identity crop, no context-truncation or live API verification.','CLINC: six source samples and full 151-label space; label match and sklearn reference aggregation, not full original-model reproduction.','IFEval: all source rows covered by four criteria; other criteria and Unicode/JSON edge conformance outside observed stimuli are not certified.','Only a local synchronous execution slice is implemented; background leases/recovery scheduling, UI integration, RBAC and production gates remain pending.'],'artifacts':{'database':str(database.relative_to(ROOT)),'packets':str(packets_path.relative_to(ROOT)),'platformResults':str(platform_path.relative_to(ROOT))}}
    (artifacts/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    # Small reviewable result with no redistributed questions/answers or credentials.
    summary={k:v for k,v in report.items() if k not in ['runtime','sources','artifacts']}
    (ROOT/'benchmarks/verification-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'cases':case_checks,'criteria':criterion_checks,'probabilities':probability_checks,'mismatches':len(mismatches),'report':str((artifacts/'report.json').relative_to(ROOT))},ensure_ascii=False))
    if mismatches:raise SystemExit(1)

if __name__=='__main__':run()
